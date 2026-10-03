import { spawn } from 'node:child_process';

export interface NotifyOptions {
  desktop: boolean;
  sound: boolean;
}

/** Strips characters that could break out of an AppleScript string literal. */
function appleScriptString(text: string): string {
  const safe = text.replace(/[\\"]/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 240);
  return `"${safe}"`;
}

/**
 * Tells the person something needs their attention: a desktop notification on
 * macOS and a terminal bell. Never throws; a failed notification is not worth
 * interrupting the bot for.
 */
export function notifyUser(title: string, message: string, options: NotifyOptions): void {
  if (options.sound && process.stdout.isTTY) {
    try {
      process.stdout.write('\u0007');
    } catch {
      // ignore
    }
  }
  if (!options.desktop || process.platform !== 'darwin') return;
  try {
    const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: false });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // ignore
  }
}
