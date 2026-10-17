import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const command = value => `node -e "process.stdout.write(Buffer.from('${Buffer.from(value).toString('base64')}','base64'))"\r`;
import { createBridge } from '../server.mjs';

const token = 'test-only-012345678901234567890123456789';
function messages(ws) {
  const buffered = [], waiting = [];
  ws.on('message', data => {
    const value = JSON.parse(data.toString());
    const item = waiting.find(w => w.check(value));
    if (item) { waiting.splice(waiting.indexOf(item), 1); clearTimeout(item.timer); item.resolve(value); }
    else buffered.push(value);
  });
  return (check = () => true) => {
    const index = buffered.findIndex(check);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { check, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('Message timeout')); }, 6000) }; waiting.push(item);
    });
  };
}
test('real PTY: auth, input, disconnect replay, isolation, resize, close', async t => {
  const bridge = createBridge({ token });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = (url, method = 'GET', data, cookie, origin = base) => fetch(base + url, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined
  });
  assert.equal((await request('/api/sessions')).status, 401);
  assert.equal((await request('/api/login', 'POST', { token }, null, 'https://evil.example')).status, 403);
  assert.equal((await request('/api/login', 'POST', { token: 'wrong' })).status, 401);
  const login = await request('/api/login', 'POST', { token });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/sessions', 'POST', { agent: 'bad' }, cookie)).status, 400);
  assert.equal((await request('/api/sessions', 'POST', { agent: 'shell' }, cookie, 'https://evil.example')).status, 403);
  const created = await request('/api/sessions', 'POST', { agent: 'shell' }, cookie);
  assert.equal(created.status, 201); const session = await created.json();
  const dial = async (origin = base) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie, Origin: origin } });
    const next = messages(ws); await once(ws, 'open'); return { ws, next };
  };
  const { ws, next } = await dial();
  ws.send(JSON.stringify({ type: 'attach', id: session.id }));
  assert.equal((await next(m => m.type === 'snapshot')).session.id, session.id);
  ws.send(JSON.stringify({ type: 'resize', cols: -1, rows: 20 }));
  await next(m => m.type === 'error');
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'input', data: command('AGENT_中文_OK\n') }));
  // Command contains base64; this marker must come from execution, not terminal echo.
  let output = '';
  while (!output.includes('AGENT_中文_OK')) output += (await next(m => m.type === 'output')).data;
  // An individual keystroke must reach the actual terminal before Enter is sent.
  ws.send(JSON.stringify({ type: 'input', data: 'Z' }));
  await next(m => m.type === 'output' && m.data.includes('Z'));
  ws.send(JSON.stringify({ type: 'input', data: '\x7f' }));
  ws.close(); await once(ws, 'close');
  const s = bridge.sessions.get(session.id);
  assert.equal(s.running, true);
  const offlineOutput = new Promise(resolve => { const sub = s.proc.onData(data => { if (data.includes('OFFLINE_REPLAY')) { sub.dispose(); resolve(); } }); });
  s.proc.write(command('OFFLINE_REPLAY\n'));
  await offlineOutput;
  const second = await dial(); second.ws.send(JSON.stringify({ type: 'attach', id: session.id }));
  const replay = await second.next(m => m.type === 'snapshot');
  assert.match(replay.data, /AGENT_中文_OK/); assert.match(replay.data, /OFFLINE_REPLAY/);
  const invalid = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  invalid.on('error', () => {});
  const [requestObject, response] = await once(invalid, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume(); requestObject.destroy(); invalid.terminate();
  assert.equal((await request('/api/sessions/' + session.id, 'DELETE', null, cookie)).status, 200);
  await second.next(m => m.type === 'deleted');
  assert.equal(bridge.sessions.has(session.id), false);
  assert.equal((await request('/api/logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await request('/api/sessions', 'GET', null, cookie)).status, 401);
});
test('refuses weak secrets and nonexistent workspaces', () => {
  assert.throws(() => createBridge({ token: '123' }));
  assert.throws(() => createBridge({ token, cwd: '/does-not-exist-bridge' }));
});
