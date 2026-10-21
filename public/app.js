const $ = id => document.getElementById(id);
const names = { codex: 'Codex', claude: 'Claude Code', shell: '系统终端' };
let ws, term, fit, selected, retry, generation = 0, active = false, attached = false, running = false;
let sessions = [], pendingDelete = null, createBusy = false, submitting = false;
const drafts = new Map();
const notice = text => { $('notice').textContent = text; };
function setStatus(text, state = '') { $('status').textContent = text; $('status').dataset.state = state; }
async function api(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
  const data = await r.json();
  if (r.status === 401) showLogin();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}
function closeSidebar() { if ($('sidebarDialog').open) $('sidebarDialog').close(); }
function showLogin() {
  active = false; generation++; clearTimeout(retry); if (ws) ws.close(); ws = null; attached = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('login').hidden = false; $('workspace').hidden = true; setStatus('未登录'); updateSend();
}
function ready() { return attached && running && ws?.readyState === WebSocket.OPEN; }
function updateSend() {
  $('send').disabled = !ready() || !$('message').value.length || submitting;
  for (const button of document.querySelectorAll('[data-key]')) button.disabled = !ready();
  $('stop').disabled = !selected;
}
function input(data) {
  if (!ready()) { notice('终端尚未连接或已经退出，内容未发送。'); return false; }
  ws.send(JSON.stringify({ type: 'input', data })); return true;
}
function resize() {
  if (!term || $('workspace').hidden || $('terminalPanel').hidden) return;
  try { fit.fit(); } catch { return; }
  if (attached && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: Math.max(20, Math.min(300, term.cols)), rows: Math.max(5, Math.min(120, term.rows)) }));
}
function applyTerminalTheme() {
  if (!term) return;
  const css = getComputedStyle(document.documentElement);
  term.options.theme = {
    background: css.getPropertyValue('--cg-canvas').trim(), foreground: css.getPropertyValue('--cg-text').trim(),
    cursor: css.getPropertyValue('--cg-text').trim(), selectionBackground: document.documentElement.dataset.theme === 'dark' ? '#55555588' : '#b5b5b588'
  };
}
function renderSessions() {
  $('sessionEmpty').hidden = sessions.length > 0;
  const previousFocus = document.activeElement?.dataset.sessionId;
  $('sessionList').replaceChildren(...sessions.map(s => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'session-row'; button.dataset.sessionId = s.id;
    button.title = `${names[s.agent] || s.agent} · ${s.id}`;
    if (s.id === selected) button.setAttribute('aria-current', 'page');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.classList.add('cg-icon'); icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-terminal'); icon.append(use);
    const copy = document.createElement('span'); copy.className = 'session-copy';
    const title = document.createElement('strong'); title.textContent = names[s.agent] || s.agent;
    const subtitle = document.createElement('small'); subtitle.textContent = `${s.id.slice(0, 6)} · ${s.running ? '运行中' : '已退出'}`;
    copy.append(title, subtitle); const dot = document.createElement('span'); dot.className = `session-dot${s.running ? '' : ' exited'}`; dot.setAttribute('aria-hidden', 'true');
    button.append(icon, copy, dot); button.onclick = () => selectSession(s.id); return button;
  }));
  if (previousFocus) [...$('sessionList').children].find(el => el.dataset.sessionId === previousFocus)?.focus();
  const current = sessions.find(s => s.id === selected);
  $('sessionTitle').textContent = current ? names[current.agent] || current.agent : '工作区';
  $('terminalCaption').textContent = current ? `${names[current.agent] || current.agent} / ${current.id.slice(0, 6)}` : '终端输出';
  $('welcome').hidden = !!selected; $('terminalPanel').hidden = !selected;
  document.querySelector('.input-area').dataset.empty = String(!selected);
  $('message').placeholder = current ? `发送到 ${names[current.agent] || current.agent}…` : '先新建一个会话，再发送指令…';
  updateSend();
}
function saveDraft() { if (selected) drafts.set(selected, $('message').value); }
function restoreDraft() { $('message').value = drafts.get(selected) || ''; resizeTextarea(); }
function selectSession(id) {
  saveDraft(); selected = id; restoreDraft(); notice(''); renderSessions(); closeSidebar(); connect();
}
function connect() {
  clearTimeout(retry); const ownGeneration = ++generation;
  if (ws) ws.close(); attached = false; updateSend();
  if (!selected || !active) { setStatus('无活动会话'); return; }
  setStatus('正在连接');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); ws = socket;
  socket.onopen = () => { if (ownGeneration === generation) socket.send(JSON.stringify({ type: 'attach', id: selected })); };
  socket.onmessage = event => {
    if (ownGeneration !== generation) return;
    const m = JSON.parse(event.data);
    if (m.type === 'snapshot') {
      term.reset(); term.write(m.data); attached = true; running = m.session.running;
      setStatus(running ? '已连接' : `已退出 (${m.session.exitCode})`, running ? 'connected' : ''); updateSend(); resize();
    } else if (m.type === 'output') term.write(m.data);
    else if (m.type === 'exit') { running = false; updateSend(); setStatus(`已退出 (${m.exitCode})`); refresh().catch(e => notice(e.message)); }
    else if (m.type === 'deleted') {
      const removed = selected; drafts.delete(removed); selected = null; attached = false; updateSend();
      refresh().then(() => { restoreDraft(); connect(); }).catch(e => notice(e.message));
    } else if (m.type === 'error') notice(m.error);
  };
  socket.onclose = event => {
    if (ownGeneration !== generation || !active) return;
    attached = false; updateSend();
    if (event.code === 4001) { showLogin(); notice('登录已过期，请重新输入密钥。'); return; }
    setStatus('断开，正在重连'); retry = setTimeout(async () => {
      try { await refresh(); if (active) connect(); } catch (e) { notice(e.message); if (active) connect(); }
    }, 2000);
  };
  socket.onerror = () => {};
}
async function refresh() {
  const data = await api('/api/sessions'); sessions = data.sessions;
  $('cwd').textContent = data.cwd; $('cwd').title = data.cwd; $('dialogCwd').textContent = data.cwd;
  if (!sessions.some(s => s.id === selected)) { saveDraft(); selected = sessions[0]?.id; restoreDraft(); }
  renderSessions();
  if (!selected) { attached = false; updateSend(); setStatus('无活动会话'); }
}
async function showWorkspace() {
  await refresh(); active = true; $('login').hidden = true; $('workspace').hidden = false;
  if (!term) {
    term = new Terminal({ fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('terminal')); applyTerminalTheme();
    term.onData(data => input(data)); new ResizeObserver(resize).observe($('terminal'));
  }
  resize(); connect();
}
function resizeTextarea() {
  const el = $('message'); el.style.height = 'auto'; el.style.height = `${Math.min(160, el.scrollHeight)}px`; updateSend();
}
$('message').oninput = () => { saveDraft(); resizeTextarea(); };
$('message').onkeydown = e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('inputForm').requestSubmit(); }
};
$('loginForm').onsubmit = async e => {
  e.preventDefault(); if ($('loginButton').disabled) return;
  $('loginButton').disabled = true; $('loginButton').textContent = '正在连接…'; $('token').removeAttribute('aria-invalid');
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) }); $('token').value = ''; notice(''); await showWorkspace(); }
  catch (e) { $('token').setAttribute('aria-invalid', 'true'); notice(e.message); }
  finally { $('loginButton').disabled = false; $('loginButton').textContent = '连接电脑'; }
};
function openNew(agent) {
  closeSidebar(); $('createError').textContent = ''; if (agent) $('agent').value = agent;
  $('newDialog').showModal(); $('agent').focus();
}
for (const button of document.querySelectorAll('[data-new-session]')) button.onclick = () => openNew();
for (const button of document.querySelectorAll('[data-agent]')) button.onclick = () => openNew(button.dataset.agent);
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('createForm').onsubmit = async e => {
  e.preventDefault(); if (createBusy) return; createBusy = true;
  $('create').disabled = true; $('create').textContent = '正在创建…'; $('createError').textContent = '';
  try {
    const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ agent: $('agent').value }) });
    saveDraft(); selected = s.id; restoreDraft(); await refresh(); connect(); $('newDialog').close(); notice('');
  } catch (e) { $('createError').textContent = e.message; }
  finally { createBusy = false; $('create').disabled = false; $('create').textContent = '创建会话'; }
};
$('newDialog').addEventListener('cancel', e => { if (createBusy) e.preventDefault(); });
$('refresh').onclick = async () => {
  $('refresh').disabled = true;
  try { await refresh(); connect(); notice(''); } catch (e) { notice(e.message); } finally { $('refresh').disabled = false; }
};
$('inputForm').onsubmit = e => {
  e.preventDefault(); const value = $('message').value;
  if (!value.length || submitting) return;
  if (!ready()) { notice('请先连接一个运行中的会话，草稿已保留。'); return; }
  const targetSocket = ws, targetSession = selected; const appendEnter = $('enter').checked;
  term.paste(value.replace(/\x1b/g, ''));
  $('message').value = ''; drafts.delete(selected); resizeTextarea(); notice('');
  if (appendEnter) {
    submitting = true; updateSend();
    setTimeout(() => {
      if (ws === targetSocket && selected === targetSession && ready()) input('\r');
      else notice('连接已变化，提交状态未知。请查看原会话确认，请勿盲目重复发送。');
      submitting = false; updateSend();
    }, 100);
  }
};
for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => input(JSON.parse(`"${button.dataset.key}"`));
$('latest').onclick = () => term?.scrollToBottom();
$('stop').onclick = () => {
  if (!selected) return; pendingDelete = selected; $('deleteError').textContent = ''; $('deleteDialog').showModal();
};
$('confirmDelete').onclick = async () => {
  if (!pendingDelete || $('confirmDelete').disabled) return;
  const deleting = pendingDelete; $('confirmDelete').disabled = true;
  try {
    await api(`/api/sessions/${deleting}`, { method: 'DELETE' }); drafts.delete(deleting);
    if (selected === deleting) selected = null;
    await refresh(); restoreDraft(); connect(); $('deleteDialog').close(); notice('');
  } catch (e) { $('deleteError').textContent = e.message; }
  finally { $('confirmDelete').disabled = false; }
};
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/api/logout', { method: 'POST', body: '{}' }); drafts.clear(); $('message').value = ''; showLogin(); notice(''); }
  catch (e) { notice(e.message); } finally { $('logout').disabled = false; }
};
const narrow = matchMedia('(max-width: 1023px)');
$('openSidebar').onclick = () => {
  if (narrow.matches) {
    $('sidebarDialog').append($('sidebar')); $('sidebarDialog').showModal(); $('openSidebar').setAttribute('aria-expanded', 'true');
  } else {
    $('workspace').classList.toggle('sidebar-collapsed'); $('openSidebar').setAttribute('aria-expanded', String(!$('workspace').classList.contains('sidebar-collapsed'))); resize();
  }
};
$('closeSidebar').onclick = closeSidebar;
$('sidebarDialog').addEventListener('close', () => {
  $('sidebarSlot').append($('sidebar')); $('openSidebar').setAttribute('aria-expanded', 'false'); $('openSidebar').focus();
});
$('sidebarDialog').onclick = e => { if (e.target === $('sidebarDialog') && e.clientX >= $('sidebarDialog').getBoundingClientRect().right) closeSidebar(); };
narrow.addEventListener('change', () => { closeSidebar(); $('workspace').classList.remove('sidebar-collapsed'); $('openSidebar').setAttribute('aria-expanded', String(!narrow.matches)); resize(); });
$('openSidebar').setAttribute('aria-expanded', String(!narrow.matches));
for (const select of document.querySelectorAll('.theme-select')) { select.value = window.bridgeTheme.get(); select.onchange = () => { window.bridgeTheme.set(select.value); for (const other of document.querySelectorAll('.theme-select')) other.value = select.value; }; }
document.addEventListener('bridge-theme-change', applyTerminalTheme);
function viewportHeight() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
window.visualViewport?.addEventListener('resize', viewportHeight); window.addEventListener('resize', viewportHeight); viewportHeight();
updateSend();
showWorkspace().catch(e => { showLogin(); if (e.message !== '请先登录') notice(e.message); });
