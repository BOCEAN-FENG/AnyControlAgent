import { createBridge } from '../server.mjs';
const bridge = createBridge({ token: process.env.BRIDGE_TOKEN, cwd: process.env.BRIDGE_CWD });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await bridge.close();
  process.exit(0);
}
bridge.server.on('error', error => { console.error(error.message); process.exit(1); });
bridge.server.listen(0, '127.0.0.1', () => console.log('READY:' + bridge.server.address().port));
process.stdin.resume();
process.stdin.on('data', data => { if (data.toString().includes('stop')) stop(); });
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
