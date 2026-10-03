import { spawn, type ChildProcess } from 'node:child_process';

export interface KeepAwake {
  /** True if the computer is being kept from idle-sleeping. */
  active: boolean;
  stop(): void;
}

/**
 * Keeps the computer from going to sleep on its own while the bot runs.
 * macOS only, using the built-in `caffeinate`, which exits by itself when this
 * process ends. It does not stop sleep caused by closing a laptop lid.
 * On other systems this does nothing.
 */
export function keepAwake(enabled: boolean): KeepAwake {
  if (!enabled || process.platform !== 'darwin') return { active: false, stop: () => undefined };
  let child: ChildProcess | null = null;
  const handle: KeepAwake = {
    active: false,
    stop: () => {
      handle.active = false;
      if (child && child.exitCode === null) child.kill();
      child = null;
    },
  };
  try {
    child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    handle.active = true;
    child.on('error', () => {
      handle.active = false;
    });
    child.on('exit', () => {
      handle.active = false;
    });
    child.unref();
  } catch {
    handle.active = false;
  }
  return handle;
}
