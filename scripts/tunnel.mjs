import { spawn } from 'node:child_process';
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: 'inherit', shell: false });
child.on('error', error => { console.error(`无法启动 cloudflared: ${error.message}\n请先安装 cloudflared，并重新打开终端。`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
