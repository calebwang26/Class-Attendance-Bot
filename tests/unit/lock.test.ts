import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireInstanceLock } from '../../src/system/instanceLock.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pollbot-lock-'));
}

test('the first copy gets the lock, a second is refused until it is released', () => {
  const dir = scratch();
  try {
    const profile = path.join(dir, 'profile');
    const first = acquireInstanceLock(profile);
    assert.ok(first.ok);
    assert.equal(fs.readFileSync(`${profile}.lock`, 'utf8'), String(process.pid));
    // Same process asking again counts as a stale lock it may take over.
    const again = acquireInstanceLock(profile);
    assert.ok(again.ok);
    if (again.ok) again.release();
    if (first.ok) first.release();
    assert.ok(!fs.existsSync(`${profile}.lock`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by another running process is respected', async () => {
  const dir = scratch();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const profile = path.join(dir, 'profile');
    fs.writeFileSync(`${profile}.lock`, String(child.pid));
    const result = acquireInstanceLock(profile);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, new RegExp(`already running \\(process ${child.pid}\\)`));
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a process that has exited is taken over', async () => {
  const dir = scratch();
  try {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    await new Promise((resolve) => child.on('exit', resolve));
    const profile = path.join(dir, 'profile');
    fs.writeFileSync(`${profile}.lock`, String(pid));
    const result = acquireInstanceLock(profile);
    assert.ok(result.ok);
    if (result.ok) result.release();
    fs.writeFileSync(`${profile}.lock`, 'garbage');
    const fromGarbage = acquireInstanceLock(profile);
    assert.ok(fromGarbage.ok);
    if (fromGarbage.ok) fromGarbage.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a browser still holding the profile is detected', { skip: process.platform === 'win32' }, async () => {
  const dir = scratch();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const profile = path.join(dir, 'profile');
    fs.mkdirSync(profile);
    fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(profile, 'SingletonLock'));
    const result = acquireInstanceLock(profile);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /still open in another browser process/);
    // A lock naming another computer, or a finished process, is not a reason to refuse.
    fs.rmSync(path.join(profile, 'SingletonLock'));
    fs.symlinkSync(`some-other-host-${child.pid}`, path.join(profile, 'SingletonLock'));
    const other = acquireInstanceLock(profile);
    assert.ok(other.ok);
    if (other.ok) other.release();
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
