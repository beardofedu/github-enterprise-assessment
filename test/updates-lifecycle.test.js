import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer, createConnection } from 'node:net';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdates } from '../src/updates.js';

const exec = promisify(execFile);
const head = 'a'.repeat(40);
const latest = 'b'.repeat(40);

function updateFixture(overrides = {}) {
  const calls = [];
  const logs = [];
  const config = { branch: 'main', changes: '', ancestor: false, ...overrides };
  return {
    calls, logs,
    options: {
      appDir: process.cwd(),
      log: (message) => logs.push(message),
      confirm: async () => { calls.push(['confirm']); return config.accept ?? false; },
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, undefined);
        return { ok: true, json: async () => ({ sha: config.latest ?? latest }) };
      },
      execImpl: async (command, args) => {
        if (command !== 'git') {
          calls.push([command, ...args]);
          if (config.npmError) throw new Error('dependency installation failed');
          return { stdout: '', stderr: '' };
        }
        const gitArgs = args.slice(2);
        calls.push(gitArgs);
        switch (gitArgs[0]) {
          case 'rev-parse': return { stdout: gitArgs[1] === '--show-toplevel' ? realpathSync(process.cwd()) : `${head}\n` };
          case 'branch': return { stdout: config.branch };
          case 'status': return { stdout: config.changes };
          case 'merge-base':
            if (config.ancestor) return { stdout: '' };
            throw Object.assign(new Error('not an ancestor'), { code: 128 });
          case 'merge':
            if (config.mergeError) throw new Error('Not possible to fast-forward');
            return { stdout: '' };
          default: return { stdout: '' };
        }
      },
    },
  };
}

test('startup updates skip current or locally ahead checkouts', async () => {
  for (const config of [{ latest: head }, { ancestor: true }]) {
    const fixture = updateFixture(config);
    assert.equal(await checkForUpdates(fixture.options), false);
    assert.equal(fixture.calls.some(([command]) => command === 'confirm'), false);
  }
});

test('startup updates report offline, HTTP, and invalid-response failures without stopping the command', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: true, json: async () => ({ sha: '--bad-input' }) }),
  ]) {
    const fixture = updateFixture();
    assert.equal(await checkForUpdates({ ...fixture.options, fetchImpl }), false);
    assert.match(fixture.logs.join('\n'), /Warning: could not check/);
    assert.equal(fixture.calls.some(([command]) => command === 'confirm'), false);
  }
});

test('startup updates protect dirty and feature-branch checkouts and respect declined prompts', async () => {
  for (const config of [{ changes: ' M README.md' }, { branch: 'feature' }, { accept: false }]) {
    const fixture = updateFixture(config);
    assert.equal(await checkForUpdates(fixture.options), false);
    assert.equal(fixture.calls.some(([command]) => ['fetch', 'merge', 'npm'].includes(command)), false);
    assert.match(fixture.logs.join('\n'), /Application update available/);
  }
});

test('accepted updates fetch the canonical repository, fast-forward the checked commit, and install dependencies', async () => {
  const fixture = updateFixture({ accept: true });
  assert.equal(await checkForUpdates(fixture.options), true);
  assert.deepEqual(fixture.calls.slice(-3), [
    ['fetch', '--no-tags', 'https://github.com/beardofedu/github-enterprise-assessment.git', 'main'],
    ['merge', '--ff-only', latest],
    [process.platform === 'win32' ? 'npm.cmd' : 'npm', 'ci'],
  ]);
  assert.match(fixture.logs.at(-1), /Rerun your command/);
});

test('updates refuse edits made during confirmation and surface merge or dependency failures', async () => {
  const changed = updateFixture({ accept: true });
  const originalExec = changed.options.execImpl;
  let statuses = 0;
  changed.options.execImpl = async (command, args, opts) => {
    if (args[2] === 'status' && ++statuses === 2) return { stdout: ' M README.md' };
    return originalExec(command, args, opts);
  };
  await assert.rejects(checkForUpdates(changed.options), /Checkout changed/);
  assert.equal(changed.calls.some(([command]) => command === 'fetch'), false);
  for (const config of [{ mergeError: true }, { npmError: true }]) {
    const fixture = updateFixture({ accept: true, ...config });
    await assert.rejects(checkForUpdates(fixture.options), config.mergeError ? /fast-forward/ : /files updated.*dependencies were not installed/);
    assert.equal(fixture.logs.some((message) => message.startsWith('Application updated.')), false);
  }
});

test('an accepted update changes a real checkout without touching ignored assessment data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assessment-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'upstream');
  const checkout = join(dir, 'checkout');
  await exec('git', ['init', '-q', '-b', 'main', remote]);
  const git = (...args) => exec('git', ['-C', remote, ...args]);
  writeFileSync(join(remote, '.gitignore'), 'answers.json\n');
  writeFileSync(join(remote, 'functionality.txt'), 'old');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial fixture');
  await exec('git', ['clone', '-q', remote, checkout]);
  writeFileSync(join(remote, 'functionality.txt'), 'new');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'updated fixture');
  const { stdout: sha } = await git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'answers.json'), '{"demo":"yes"}');
  let installed = false;
  assert.equal(await checkForUpdates({
    appDir: checkout,
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: sha.trim() }) }),
    confirm: async () => true,
    log: () => {},
    execImpl: async (command, args, opts) => {
      if (command !== 'git') {
        assert.equal(opts.cwd, checkout);
        installed = true;
        return { stdout: '', stderr: '' };
      }
      const redirected = [...args];
      if (args[2] === 'fetch') redirected[4] = remote;
      return exec(command, redirected, opts);
    },
  }), true);
  assert.equal(readFileSync(join(checkout, 'functionality.txt'), 'utf8'), 'new');
  assert.equal(readFileSync(join(checkout, 'answers.json'), 'utf8'), '{"demo":"yes"}');
  assert.equal(installed, true);
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', read);
      child.stderr.off('data', read);
      child.off('exit', exited);
    };
    const exited = (code) => {
      cleanup();
      reject(new Error(`Process exited (${code}) before ${pattern}: ${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}: ${output}`));
    }, 8000);
    const read = (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', exited);
    child.once('error', (error) => { cleanup(); reject(error); });
  });
}

test('dashboard signals close active connections and release the listening port', async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const port = await freePort();
    const child = spawn(process.execPath, ['bin/gh-waf-assess.js', 'serve', '--demo', '--skip-update-check', '--port', String(port)]);
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await waitForOutput(child, /Dashboard:/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/assessment`)).status, 200);
    const socket = createConnection(port, '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write('GET / HTTP/1.1\r\n');
    const disconnected = once(socket, 'close');
    const exit = once(child, 'exit');
    child.kill(signal);
    assert.equal((await exit)[0], code);
    await disconnected;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/assessment`));
  }
});

test('dashboard exits when its launching shell dies even if the npm-like parent survives', { skip: process.platform === 'win32' }, async (t) => {
  const port = await freePort();
  const args = ['bin/gh-waf-assess.js', 'serve', '--demo', '--skip-update-check', '--port', String(port)];
  const middle = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:'inherit'}); console.log('CHILD '+child.pid); setInterval(()=>{},1000);`;
  const outer = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'}); console.log('PARENT '+child.pid); setInterval(()=>{},1000);`;
  const launcher = spawn(process.execPath, ['-e', outer]);
  const pids = [];
  let pidOutput = '';
  launcher.stdout.on('data', (chunk) => {
    pidOutput += chunk;
    for (const match of pidOutput.matchAll(/(?:PARENT|CHILD) (\d+)/g)) {
      const pid = Number(match[1]);
      if (!pids.includes(pid)) pids.push(pid);
    }
  });
  t.after(() => {
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  await waitForOutput(launcher, /Dashboard:/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/assessment`)).status, 200);
  launcher.kill('SIGKILL');
  const deadline = Date.now() + 5000;
  let closed = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { await fetch(`http://127.0.0.1:${port}/api/assessment`); } catch { closed = true; break; }
  }
  assert.equal(closed, true, 'orphaned dashboard should close its port within five seconds');
  const { stdout: state } = await exec('ps', ['-o', 'stat=', '-p', String(pids[1])]).catch((error) => {
    if (error.code === 1 && !error.stdout.trim()) return { stdout: '' };
    throw error;
  });
  assert.ok(!state.trim() || state.trim().startsWith('Z'), 'dashboard process must be exited, not just stop listening');
  assert.doesNotThrow(() => process.kill(pids[0], 0), 'npm-like parent is still alive');
});
