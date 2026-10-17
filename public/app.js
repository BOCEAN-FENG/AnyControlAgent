const $ = id => document.getElementById(id);
let ws, term, fit, selected, retry, generation = 0, active = false, attached = false, running = false;
const notice = text => { $('notice').textContent = text; };
async function api(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
  const data = await r.json();
  if (r.status === 401) showLogin();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}
function showLogin() {
  active = false; generation++; clearTimeout(retry); if (ws) ws.close(); ws = null;
  $('login').hidden = false; $('workspace').hidden = true; $('status').textContent = '未登录';
}
function ready() { return attached && running && ws?.readyState === WebSocket.OPEN; }
function updateSend() { $('send').disabled = !ready(); }
function input(data) {
  if (!ready()) { notice('终端尚未连接或已经退出，输入未发送。'); return false; }
  ws.send(JSON.stringify({ type: 'input', data })); return true;
}
function resize() {
  if (!term || $('workspace').hidden) return;
  fit.fit(); if (attached && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: Math.max(20, Math.min(300, term.cols)), rows: Math.max(5, Math.min(120, term.rows)) }));
}
function connect() {
  clearTimeout(retry); const ownGeneration = ++generation;
  if (ws) ws.close(); attached = false; updateSend();
  if (!selected || !active) return;
  $('status').textContent = '正在连接…';
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); ws = socket;
  socket.onopen = () => { if (ownGeneration === generation) socket.send(JSON.stringify({ type: 'attach', id: selected })); };
  socket.onmessage = event => {
    if (ownGeneration !== generation) return;
    const m = JSON.parse(event.data);
    if (m.type === 'snapshot') {
      term.reset(); term.write(m.data); attached = true; running = m.session.running;
      $('status').textContent = running ? '● 已连接' : `终端已退出 (${m.session.exitCode})`; updateSend(); resize();
    } else if (m.type === 'output') term.write(m.data);
    else if (m.type === 'exit') { running = false; updateSend(); $('status').textContent = `终端已退出 (${m.exitCode})`; refresh().catch(e => notice(e.message)); }
    else if (m.type === 'deleted') { selected = null; attached = false; updateSend(); refresh().catch(e => notice(e.message)); }
    else if (m.type === 'error') notice(m.error);
  };
  socket.onclose = event => {
    if (ownGeneration !== generation || !active) return;
    attached = false; updateSend();
    if (event.code === 4001) { showLogin(); notice('登录已过期，请重新输入密钥。'); return; }
    $('status').textContent = '连接断开，正在重连…'; retry = setTimeout(async () => {
      try { await refresh(); if (active) connect(); } catch (e) { notice(e.message); if (active) connect(); }
    }, 2000);
  };
  socket.onerror = () => {};
}
async function refresh() {
  const data = await api('/api/sessions');
  $('cwd').textContent = data.cwd;
  $('sessions').replaceChildren(...data.sessions.map(s => {
    const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.agent} · ${s.id.slice(0, 6)}${s.running ? '' : ' · 已退出'}`; return o;
  }));
  if (!data.sessions.some(s => s.id === selected)) selected = data.sessions[0]?.id;
  if (selected) $('sessions').value = selected;
  else { attached = false; updateSend(); $('status').textContent = '请选择 Agent 并新建会话'; }
}
async function showWorkspace() {
  await refresh(); active = true; $('login').hidden = true; $('workspace').hidden = false;
  if (!term) {
    term = new Terminal({ theme: { background: '#10181e', foreground: '#e1e9eb' }, fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('terminal'));
    term.onData(data => input(data)); new ResizeObserver(resize).observe($('terminal'));
  }
  resize(); connect();
}
$('loginForm').onsubmit = async e => {
  e.preventDefault(); try { await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) }); $('token').value = ''; notice(''); await showWorkspace(); } catch (e) { notice(e.message); }
};
$('create').onclick = async () => {
  $('create').disabled = true;
  try { const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ agent: $('agent').value }) }); selected = s.id; await refresh(); connect(); notice(''); } catch (e) { notice(e.message); } finally { $('create').disabled = false; }
};
$('sessions').onchange = () => { selected = $('sessions').value; connect(); };
$('refresh').onclick = async () => { try { await refresh(); connect(); } catch (e) { notice(e.message); } };
$('inputForm').onsubmit = e => {
  e.preventDefault(); const value = $('message').value;
  if (!value) return;
  if (ready()) {
    const targetSocket = ws; const targetSession = selected;
    term.paste(value.replace(/\x1b/g, ''));
    if ($('enter').checked) setTimeout(() => {
      if (ws === targetSocket && selected === targetSession && ready()) input('\r');
    }, 100);
    $('message').value = ''; notice('');
  }
};
for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => input(JSON.parse(`"${button.dataset.key}"`));
$('stop').onclick = async () => {
  if (!selected || !confirm('关闭这个终端及其中正在运行的 Agent？')) return;
  try { await api(`/api/sessions/${selected}`, { method: 'DELETE' }); selected = null; await refresh(); connect(); } catch (e) { notice(e.message); }
};
$('logout').onclick = async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); showLogin(); } catch (e) { notice(e.message); } };
showWorkspace().catch(e => { showLogin(); if (e.message !== '请先登录') notice(e.message); });
