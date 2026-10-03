import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LockResult = { ok: true; release: () => void } | { ok: false; reason: string };

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Chromium marks a profile in use with a "SingletonLock" link whose target is
 * "<hostname>-<pid>". A browser still holding the profile (for example one
 * left running by a copy of the bot that was killed) makes a new launch hang,
 * so it is checked up front.
 */
function browserHoldingProfile(profileDir: string): number | null {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== os.hostname()) return null;
  const pid = Number(match[2]);
  return alive(pid) ? pid : null;
}

/**
 * Makes sure only one copy of the bot uses a browser profile (and its
 * answered-polls file) at a time. The lock is a file holding this process's
 * id, created exclusively; a lock left by a process that no longer exists is
 * taken over.
 */
export function acquireInstanceLock(profileDir: string): LockResult {
  const browserPid = browserHoldingProfile(profileDir);
  if (browserPid !== null) {
    return {
      ok: false,
      reason: `The bot's browser profile is still open in another browser process (${browserPid}). Close that browser window (or the other copy of the bot) and try again.`,
    };
  }

  const file = `${path.resolve(profileDir)}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file);
        } catch {
          // Already gone.
        }
      };
      process.once('exit', release);
      return { ok: true, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(fs.readFileSync(file, 'utf8').trim());
      } catch {
        // Unreadable: treat as stale.
      }
      if (alive(holder) && holder !== process.pid) {
        return {
          ok: false,
          reason: `Another copy of the bot is already running (process ${holder}). Stop it first (Ctrl+C in its terminal, or close its browser window).`,
        };
      }
      // Left behind by a copy that is no longer running.
      fs.rmSync(file, { force: true });
    }
  }
  return { ok: false, reason: `Could not lock ${file}. Try again.` };
}
