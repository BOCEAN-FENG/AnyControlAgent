import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/AnyControlAgent-Windows');
const packagedRuntime = process.platform === 'win32' && existsSync(path.join(root, 'runtime/node.exe'));
test('portable runtime: launch, authenticate, create PTY and shut down via stdin', {
  timeout: 15000, skip: packagedRuntime ? false : 'Build the Windows portable package with desktop/build.ps1 first'
}, async t => {
  const token = 'portable-test-secret-01234567890123456789';
  const proc = spawn(path.join(root, 'runtime/node.exe'), [path.join(root, 'desktop/host.mjs')], {
    cwd: root, env: { ...process.env, BRIDGE_TOKEN: token, BRIDGE_CWD: root }, windowsHide: true
  });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  let errors = ''; proc.stderr.on('data', data => { errors += data; });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    proc.stdout.on('data', data => { output += data; const match = /READY:(\d+)/.exec(output); if (match) resolve(match[1]); });
    proc.once('error', reject);
    proc.once('exit', code => reject(new Error(`Early exit ${code}: ${errors}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).status, 200);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await fetch(base + '/api/sessions', { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'shell' }) });
  assert.equal(session.status, 201);
  assert.equal((await session.json()).running, true);
  const exited = once(proc, 'exit');
  proc.stdin.end('stop\n');
  assert.equal((await exited)[0], 0, errors);
  // node-pty's console-list helper may log AttachConsole failed during Windows teardown.
  assert.doesNotMatch(errors, /FATAL|ERR_MODULE_NOT_FOUND/);
  await assert.rejects(fetch(base));
});
