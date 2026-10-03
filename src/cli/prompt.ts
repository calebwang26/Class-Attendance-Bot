import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { normalizeUrl } from '../config/config.ts';

interface StateFile {
  lastUrl?: string;
}

/** Remembers the last link used, so it can be offered as the default next time. */
export function readLastUrl(stateFile: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StateFile;
    return typeof parsed.lastUrl === 'string' && parsed.lastUrl !== '' ? parsed.lastUrl : null;
  } catch {
    return null;
  }
}

export function writeLastUrl(stateFile: string, url: string): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const data: StateFile = { lastUrl: url };
    fs.writeFileSync(stateFile, `${JSON.stringify(data, null, 1)}\n`);
  } catch {
    // Only a convenience; not worth stopping for.
  }
}

/**
 * Asks for the poll link at the terminal until a usable one is given.
 * Pressing Enter with nothing typed reuses `lastUrl` when there is one.
 * Returns null if input ends (Ctrl+D) or the terminal is not interactive.
 */
export async function askForUrl(
  lastUrl: string | null,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<string | null> {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  // If input ends (Ctrl+D, or a closed pipe) a pending question never settles by
  // itself, so race every question against the interface closing.
  const closed = new Promise<null>((resolve) => {
    rl.once('close', () => resolve(null));
  });
  try {
    for (;;) {
      const hint = lastUrl ? ` (press Enter to reuse ${lastUrl})` : '';
      const answer = await Promise.race([rl.question(`Paste the poll link${hint}: `).catch(() => null), closed]);
      if (answer === null) return null;
      const text = answer.trim();
      if (text === '') {
        if (lastUrl) return lastUrl;
        io.output.write('Please paste a link, for example pollev.com/yourpresenter\n');
        continue;
      }
      try {
        return normalizeUrl(text);
      } catch (error) {
        io.output.write(`That does not look right: ${(error as Error).message}. Try again.\n`);
      }
    }
  } finally {
    rl.close();
  }
}
