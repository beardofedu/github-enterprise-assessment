import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY = 'https://github.com/beardofedu/github-enterprise-assessment.git';
const COMMITS_URL = 'https://api.github.com/repos/beardofedu/github-enterprise-assessment/commits/main';

export async function checkForUpdates({
  appDir = APP_DIR, fetchImpl = fetch, execImpl = exec, log, confirm, signal,
} = {}) {
  const git = (...args) => execImpl('git', ['-C', appDir, ...args], { timeout: 10000, signal });
  let head;
  let latest;
  try {
    const { stdout: root } = await git('rev-parse', '--show-toplevel');
    if (root.trim() !== realpathSync(appDir)) {
      throw new Error('The application is not installed at the root of its own Git checkout');
    }
    ({ stdout: head } = await git('rev-parse', 'HEAD'));
    const response = await fetchImpl(COMMITS_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'github-enterprise-assessment' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    latest = (await response.json()).sha;
    if (typeof latest !== 'string' || !/^[a-f0-9]{40}$/.test(latest)) throw new Error('GitHub returned an invalid commit');
    if (latest === head.trim()) return false;
    try {
      await git('merge-base', '--is-ancestor', latest, head.trim());
      return false;
    } catch (error) {
      // A missing remote commit or a non-ancestor means the checkout may need an update.
      if (error.code !== 1 && error.code !== 128) throw error;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    log(`Warning: could not check for application updates: ${error.message}. Continuing without an update check.`);
    return false;
  }

  log(`Application update available: https://github.com/beardofedu/github-enterprise-assessment/commit/${latest}`);
  const { stdout: branch } = await git('branch', '--show-current');
  const { stdout: changes } = await git('status', '--porcelain');
  if (branch.trim() !== 'main' || changes.trim()) {
    log('Automatic installation requires a clean checkout on main. Review your local changes and update the application manually.');
    return false;
  }
  if (!await confirm('Install this application update now? The command will stop afterward; rerun it to use the update. [y/N] ')) {
    log('Update not installed. To update later, use a clean main checkout, run `git pull --ff-only`, then `npm ci` in the application directory.');
    return false;
  }
  // Recheck after the prompt so edits made while it was open are not overwritten.
  const { stdout: currentBranch } = await git('branch', '--show-current');
  const { stdout: currentChanges } = await git('status', '--porcelain');
  const { stdout: currentHead } = await git('rev-parse', 'HEAD');
  if (currentBranch.trim() !== 'main' || currentChanges.trim() || currentHead !== head) {
    throw new Error('Checkout changed during the update prompt. No update was installed.');
  }
  await git('fetch', '--no-tags', REPOSITORY, 'main');
  await git('merge', '--ff-only', latest);
  try {
    const result = await execImpl(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], {
      cwd: appDir, signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    if (result.stdout.trim()) log(result.stdout.trim());
    if (result.stderr.trim()) log(result.stderr.trim());
  } catch (error) {
    throw new Error(`Application files updated, but dependencies were not installed: ${error.message}. Run npm ci in the application directory before restarting.`);
  }
  log('Application updated. Rerun your command to use the new functionality.');
  return true;
}
