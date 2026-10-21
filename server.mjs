import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest();
export function createBridge({ token, cwd = process.cwd(), maxSessions = 6 } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('BRIDGE_TOKEN must have at least 24 characters');
  const workingDirectory = realpathSync(cwd);
  const logins = new Map(), sessions = new Map();
  let attempts = [], stopping = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const send = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.close(1013, 'Reconnect to catch up');
    ws.send(JSON.stringify(message));
  };
  const authenticated = req => {
    const key = /(?:^|;\s*)bridge=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const expires = logins.get(key);
    if (expires && expires > Date.now()) return key;
    if (key) logins.delete(key);
    return null;
  };
  const sameOrigin = req => {
    try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; }
    catch { return false; }
  };
  const info = s => ({ id: s.id, agent: s.agent, cwd: workingDirectory, running: s.running, exitCode: s.exitCode });
  const detach = ws => { if (ws.session) ws.session.clients.delete(ws); ws.session = null; };
  const assets = new Map([
    ['/', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
    ['/theme.js', ['public/theme.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['public/style.css', 'text/css']],
    ['/vendor/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
    ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
    ['/vendor/fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript']]
  ]);
  async function body(req) {
    let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 8192) throw new Error('Request too large'); }
    return JSON.parse(data);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname); res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(path.join(root, file)));
      }
      if (req.method !== 'GET' && !sameOrigin(req)) return reply(403, { error: 'Origin rejected' });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        attempts = attempts.filter(t => Date.now() - t < 60000);
        if (attempts.length >= 30) return reply(429, { error: '尝试过多，请一分钟后重试' });
        attempts.push(Date.now());
        const input = await body(req);
        if (typeof input.token !== 'string' || !timingSafeEqual(hash(input.token), hash(token))) return reply(401, { error: '访问密钥不正确' });
        for (const [key, expiry] of logins) if (expiry <= Date.now()) logins.delete(key);
        if (logins.size >= 100) return reply(429, { error: '登录数量已达上限' });
        const key = randomBytes(32).toString('hex'); logins.set(key, Date.now() + 12 * 3600000);
        const secure = new URL(req.headers.origin).protocol === 'https:' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `bridge=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
        return reply(200, { ok: true });
      }
      const key = authenticated(req);
      if (!key) return reply(401, { error: '请先登录' });
      if (req.method === 'GET' && url.pathname === '/api/sessions') return reply(200, { sessions: [...sessions.values()].map(info), cwd: workingDirectory });
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        logins.delete(key); for (const ws of wss.clients) if (ws.authKey === key) ws.close(4001);
        res.setHeader('Set-Cookie', 'bridge=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return reply(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        if (sessions.size >= maxSessions) return reply(409, { error: '会话已达上限，请先关闭旧会话' });
        const { agent } = await body(req);
        if (!['codex', 'claude', 'shell'].includes(agent)) return reply(400, { error: 'Unknown agent' });
        const windows = process.platform === 'win32';
        const command = windows ? (process.env.ComSpec || 'cmd.exe') : agent === 'shell' ? (process.env.SHELL || '/bin/bash') : agent;
        const args = windows ? (agent === 'shell' ? [] : ['/d', '/s', '/c', agent]) : [];
        const env = { ...process.env, TERM: 'xterm-256color' }; delete env.BRIDGE_TOKEN;
        const proc = pty.spawn(command, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: workingDirectory, env });
        const s = { id: randomBytes(12).toString('hex'), agent, proc, running: true, chunks: [], size: 0, clients: new Set() };
        sessions.set(s.id, s);
        proc.onData(data => {
          s.chunks.push(data); s.size += data.length;
          while (s.size > 2 * 1024 * 1024 && s.chunks.length > 1) s.size -= s.chunks.shift().length;
          for (const ws of s.clients) send(ws, { type: 'output', data });
        });
        proc.onExit(({ exitCode }) => { s.running = false; s.exitCode = exitCode; for (const ws of s.clients) send(ws, { type: 'exit', exitCode }); });
        return reply(201, info(s));
      }
      const match = /^\/api\/sessions\/([a-f0-9]{24})$/.exec(url.pathname);
      if (req.method === 'DELETE' && match) {
        const s = sessions.get(match[1]); if (!s) return reply(404, { error: '会话不存在' });
        if (s.running) s.proc.kill();
        for (const ws of s.clients) { send(ws, { type: 'deleted' }); ws.session = null; }
        sessions.delete(s.id); return reply(200, { ok: true });
      }
      reply(404, { error: 'Not found' });
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const key = authenticated(req);
    if (req.url !== '/ws' || !key || !sameOrigin(req) || wss.clients.size >= 16) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.authKey = key; wss.emit('connection', ws); });
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {}); ws.on('close', () => detach(ws));
    ws.on('message', bytes => {
      if ((logins.get(ws.authKey) || 0) <= Date.now()) return ws.close(4001, 'Login expired');
      try {
        const m = JSON.parse(bytes.toString());
        if (m.type === 'attach') {
          const s = sessions.get(m.id); if (!s) throw new Error('会话不存在');
          detach(ws); ws.session = s; s.clients.add(ws);
          send(ws, { type: 'snapshot', data: s.chunks.join(''), session: info(s) });
        } else if (m.type === 'input') {
          if (!ws.session?.running) throw new Error('终端已经退出');
          if (typeof m.data !== 'string' || m.data.length > 16384) throw new Error('输入过长');
          ws.session.proc.write(m.data);
        } else if (m.type === 'resize') {
          if (!Number.isInteger(m.cols) || !Number.isInteger(m.rows) || m.cols < 20 || m.cols > 300 || m.rows < 5 || m.rows > 120) throw new Error('Invalid size');
          if (ws.session?.running) ws.session.proc.resize(m.cols, m.rows);
        } else throw new Error('Unknown message');
      } catch (error) { send(ws, { type: 'error', error: error.message }); }
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if ((logins.get(ws.authKey) || 0) <= Date.now()) { ws.close(4001); continue; }
      if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping();
    }
  }, 15000); timer.unref();
  return { server, sessions, async close() {
    if (stopping) return; stopping = true; clearInterval(timer);
    for (const s of sessions.values()) if (s.running) s.proc.kill();
    for (const ws of wss.clients) ws.terminate(); wss.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const token = process.env.BRIDGE_TOKEN || randomBytes(24).toString('hex');
  try {
    const bridge = createBridge({ token, cwd: process.env.BRIDGE_CWD || process.cwd() });
    bridge.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    bridge.server.listen(port, '127.0.0.1', () => {
      console.log(`\nAgent Bridge: http://127.0.0.1:${port}\nWorkspace: ${process.env.BRIDGE_CWD || process.cwd()}\nAccess key (keep private): ${token}\n\nTunnel: cloudflared tunnel --url http://127.0.0.1:${port}\n`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
