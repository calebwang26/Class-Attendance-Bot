import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HELP } from '../../src/cli/args.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function flatten(value: unknown, prefix = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flatten(child, `${prefix}${key}.`));
  }
  return [[prefix.slice(0, -1), value]];
}

test('the settings table in the technical design matches the code: every setting, with its real default', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'TECHNICAL_DESIGN.md'), 'utf8');
  const start = doc.indexOf('<!-- settings-table:start -->');
  const end = doc.indexOf('<!-- settings-table:end -->');
  assert.ok(start > 0 && end > start, 'settings table markers present');
  const documented = new Map<string, unknown>();
  for (const line of doc.slice(start, end).split('\n')) {
    const match = /^\| `([^`]+)` \| `([^`]*)` \|/.exec(line);
    if (match?.[1] && match[2] !== undefined) documented.set(match[1], JSON.parse(match[2]) as unknown);
  }
  const actual = new Map(flatten(DEFAULT_CONFIG));
  assert.deepEqual([...documented.keys()].sort(), [...actual.keys()].sort(), 'documented settings = actual settings');
  for (const [key, value] of actual) assert.deepEqual(documented.get(key), value, `default of ${key}`);
});

test('the example settings file is valid and uses real settings', async () => {
  const { buildConfig } = await import('../../src/config/config.ts');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'pollbot.config.example.json'), 'utf8')) as unknown;
  assert.doesNotThrow(() => buildConfig(example));
});

test('every flag in the README options table exists in the command line', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const flags = [...readme.matchAll(/^\| `(--[a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(flags.length >= 10);
  for (const flag of flags) assert.ok(flag && HELP.includes(flag), `${flag} is in the README but not in --help`);
});
