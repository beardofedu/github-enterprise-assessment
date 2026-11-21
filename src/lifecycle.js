import { execFileSync } from 'node:child_process';

export function installLifecycle({ onShutdown = () => {}, intervalMs = 1000 } = {}) {
  const controller = new AbortController();
  const parentPid = process.ppid;
  const watchedPids = [parentPid];
  if (process.platform !== 'win32' && parentPid > 1) {
    try {
      const grandparentPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(parentPid)], {
        encoding: 'utf8', timeout: 1000,
      }).trim());
      if (Number.isInteger(grandparentPid) && grandparentPid > 1) watchedPids.push(grandparentPid);
    } catch (error) {
      process.stderr.write(`Warning: could not monitor the launching shell: ${error.message}\n`);
    }
  }
  const shutdown = (code) => {
    controller.abort();
    onShutdown();
    process.exit(code);
  };
  const handlers = new Map([
    ['SIGHUP', () => shutdown(129)],
    ['SIGINT', () => shutdown(130)],
    ['SIGTERM', () => shutdown(143)],
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  // npm can disappear without forwarding a signal when its terminal is force-quit.
  const timer = setInterval(() => {
    if (parentPid <= 1) return;
    if (process.ppid !== parentPid) return shutdown(0);
    try {
      for (const pid of watchedPids) process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') shutdown(0);
      else if (error.code !== 'EPERM') throw error;
    }
  }, intervalMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearInterval(timer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
