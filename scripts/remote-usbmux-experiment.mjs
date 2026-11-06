// SPDX-License-Identifier: GPL-3.0-or-later
// EXPERIMENT (branch experiment/remote-usbmux): can Ghost drive an iPhone whose USB
// device service (usbmuxd) lives on ANOTHER machine, reached over Tailscale?
//
// Simulation: a TCP relay on this PC's Tailscale address forwards to Apple's local
// usbmuxd (127.0.0.1:27015). Ghost's real IosAdapter + sidecar are pointed at the relay
// via USBMUXD_SOCKET_ADDRESS. A Pi with the phone plugged in would run the same relay
// (socat) in front of Linux usbmuxd.
//
// Usage: node scripts/remote-usbmux-experiment.mjs --listen 100.x.y.z:27016 --udid U [--set]
//   --set  also sends one location (Liberty Island), waits for refresh acks, then clears.
import net from 'node:net';
import path from 'node:path';
import { IosAdapter } from '../backend/ios.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, i, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const [listenHost, listenPort] = String(args.listen || '').split(':');
if (!listenHost || !Number(listenPort) || !/^[A-Za-z0-9-]{8,80}$/.test(args.udid || '')) throw new Error('Need --listen host:port and --udid.');
const runtimeRoot = args.runtime || path.resolve('../ghost-location'); // reuse the main checkout's sidecar venv

const stats = { connections: 0, upBytes: 0, downBytes: 0 };
const relay = net.createServer(client => {
  stats.connections++;
  const upstream = net.connect(27015, '127.0.0.1');
  client.on('data', d => { stats.upBytes += d.length; });
  upstream.on('data', d => { stats.downBytes += d.length; });
  client.pipe(upstream).pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
});
await new Promise((resolve, reject) => relay.listen(Number(listenPort), listenHost, resolve).once('error', reject));
const log = (step, detail = {}) => console.log(`[${new Date().toISOString()}] ${step} ${JSON.stringify(detail)}`);
log('relay-listening', { address: `${listenHost}:${listenPort}` });

async function run(address, label) {
  process.env.USBMUXD_SOCKET_ADDRESS = address; // inherited by the sidecar process
  const acks = [];
  const adapter = new IosAdapter({ rootPath: runtimeRoot, onLocationRefresh: e => acks.push(e.refreshCount), onSessionEnd: e => log(`${label}:session-ended`, { error: e.error }) });
  adapter.connection = 'usb';
  try {
    const status = await adapter.status();
    const devices = await adapter.list();
    const phone = devices.find(d => d.id === `ios:${args.udid}`);
    log(`${label}:discover`, { available: status.available, found: Boolean(phone), state: phone?.state, connection: phone?.connection, relayConnections: stats.connections });
    if (!phone || phone.state !== 'ready' || !args.set) return { phone };
    const started = Date.now();
    const result = await adapter.set(phone, { latitude: 40.689247, longitude: -74.044502, sessionId: 'remote-usbmux-experiment' });
    log(`${label}:set-acknowledged`, { ms: Date.now() - started, refreshCount: result.refreshCount });
    await new Promise(r => setTimeout(r, 6000));
    log(`${label}:refresh-acks`, { count: acks.length });
    const cleared = await adapter.clear(phone);
    log(`${label}:clear`, { cleared: cleared.cleared === true });
    return { phone, acks: acks.length };
  } finally {
    await adapter.dispose({ restore: true }).catch(() => {});
  }
}

try {
  // Negative control: a dead address must NOT silently fall back to local usbmuxd.
  await run('127.0.0.1:1', 'control-dead-address').catch(error => log('control-dead-address:error', { message: error.message.slice(0, 160) }));
  const before = stats.connections;
  await run(`${listenHost}:${listenPort}`, 'via-relay');
  log('relay-stats', { ...stats, connectionsDuringRelayRun: stats.connections - before });
} finally {
  relay.close();
}
