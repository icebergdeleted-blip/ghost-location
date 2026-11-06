import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplePeers, findTailscaleApplePeers, tailscaleCandidates } from '../backend/tailscale.mjs';
import { ConnectionAlerts } from '../backend/alerts.mjs';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';

const status = peers => JSON.stringify({ BackendState: 'Running', Peer: Object.fromEntries(peers.map((peer, i) => [`key${i}`, peer])) });

test('Tailscale lookup lists only iPhones/iPads with a tailnet IPv4, online first, names cleaned', () => {
  const result = parseApplePeers(status([
    { HostName: 'iPad', OS: 'iOS', Online: false, TailscaleIPs: ['100.122.108.51', 'fd7a:115c:a1e0::1'] },
    { HostName: "Alrex's iphone\u0007", OS: 'iOS', Online: true, TailscaleIPs: ['fd7a:115c:a1e0::2', '100.123.126.110'] },
    { HostName: 'alexrpi', OS: 'linux', Online: true, TailscaleIPs: ['100.81.200.95'] },
    { HostName: 'odd', OS: 'iOS', Online: true, TailscaleIPs: ['8.8.8.8', '100.200.0.1'] }, // not in 100.64.0.0/10
    { HostName: '', OS: 'ios', Online: true, TailscaleIPs: ['100.64.0.9'] },
  ]));
  assert.deepEqual(result, [
    { name: "Alrex's iphone", ip: '100.123.126.110', online: true },
    { name: 'Apple device', ip: '100.64.0.9', online: true },
    { name: 'iPad', ip: '100.122.108.51', online: false },
  ]);
  assert.throws(() => parseApplePeers('{'), /unreadable/);
  assert.throws(() => parseApplePeers(JSON.stringify({ BackendState: 'NeedsLogin' })), /not connected/);
  assert.deepEqual(parseApplePeers(JSON.stringify({ BackendState: 'Running', Peer: null })), []);
});

test('Tailscale lookup runs only `status --json` and explains missing or stopped Tailscale', async () => {
  assert.ok(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files' })[0].endsWith('Tailscale\\tailscale.exe'));
  await assert.rejects(findTailscaleApplePeers({ exists: () => false }), /not installed/);
  const calls = [];
  const runner = async (file, args) => { calls.push([file, args]); return { code: 0, stdout: status([{ HostName: 'p', OS: 'iOS', Online: true, TailscaleIPs: ['100.64.0.2'] }]) }; };
  assert.equal((await findTailscaleApplePeers({ runner, platform: 'darwin', exists: f => f.startsWith('/Applications') })).length, 1);
  assert.deepEqual(calls, [['/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status', '--json']]]);
  await assert.rejects(findTailscaleApplePeers({ runner: async () => ({ code: 1, stdout: '' }), exists: () => true }), /not running/);
  await assert.rejects(findTailscaleApplePeers({ runner: async () => { throw new Error('ETIMEDOUT'); }, exists: () => true }), /did not respond/);
});

const session = (status, extra = {}) => ({ session: { deviceId: 'ios:A', deviceName: 'Alex’s iPhone', connection: 'remote', autoReconnect: true, status, ...extra } });

test('alerts: a live location losing its connection alerts once, and reconnecting alerts once', () => {
  const alerts = new ConnectionAlerts();
  assert.equal(alerts.update(session('applying')), null);
  assert.equal(alerts.update(session('active')), null);
  const lost = alerts.update(session('waiting'));
  assert.equal(lost.kind, 'lost');
  assert.match(lost.title, /Alex’s iPhone: connection lost/);
  assert.match(lost.body, /remote connection dropped\. Ghost keeps retrying.*real location within about a minute/);
  assert.equal(alerts.update(session('reconnecting')), null);
  assert.equal(alerts.update(session('waiting')), null, 'a failed retry does not alert again');
  assert.equal(alerts.update(session('reconnecting')), null);
  assert.equal(alerts.update(session('active')).kind, 'reconnected');
  assert.equal(alerts.update(session('active')), null);
});

test('alerts: no automatic retry is worded honestly; Restore, phone changes and quitting never alert', () => {
  const alerts = new ConnectionAlerts();
  alerts.update(session('active'));
  assert.match(alerts.update(session('unknown', { autoReconnect: false })).body, /Reconnect the phone in Ghost, then retry or restore/);
  const restore = new ConnectionAlerts();
  for (const status of ['active', 'stopping']) assert.equal(restore.update(session(status)), null);
  assert.equal(restore.update({ session: null }), null);
  const other = new ConnectionAlerts();
  other.update(session('active'));
  assert.equal(other.update(session('waiting', { deviceId: 'ios:B' })), null);
  const quitting = new ConnectionAlerts();
  quitting.update(session('active')); quitting.suppress();
  assert.equal(quitting.update(session('unknown')), null);
  const usb = new ConnectionAlerts();
  usb.update(session('active', { connection: 'usb' }));
  assert.match(usb.update(session('waiting', { connection: 'usb' })).body, /USB connection dropped/);
});

test('a dropped remote session keeps retrying and resumes the same phone and point when it answers again', async () => {
  const UDID = '00008140-000244AE1132801C';
  const phone = { id: `ios:${UDID}`, serial: UDID, platform: 'ios', name: 'iPhone', connection: 'remote', state: 'ready' };
  const data = defaults(); Object.assign(data.preferences, { connection: 'remote', remoteHost: '100.64.0.9', remoteUdid: UDID });
  const store = { load: async () => structuredClone(data), save: async value => Object.assign(data, structuredClone(value)) };
  let reachable = true, now = 0; const sets = [];
  const ios = { status: async () => ({ available: true }), list: async () => (reachable ? [phone] : []),
    set: async (device, point) => { sets.push({ connection: device.connection, ...point }); return {}; },
    reset: async () => {}, clear: async () => {}, dispose: async () => {} };
  const c = new Controller({ adapters: { ios }, store, now: () => now });
  await c.init();
  await c.applyLocation({ deviceId: phone.id, latitude: 1, longitude: 2 });
  assert.equal(c.state.session.status, 'active');
  reachable = false;
  await c.sessionEnded({ deviceId: phone.id, sessionId: c.state.session.id, error: 'Tailscale link dropped.' });
  assert.equal(c.state.session.status, 'waiting');
  assert.equal(c.state.session.autoReconnect, true);
  now += 20000; await c.scanDevices();
  assert.equal(sets.length, 1, 'no command while the phone is unreachable');
  reachable = true; now += 20000; await c.scanDevices();
  assert.equal(c.state.session.status, 'active');
  assert.equal(sets.length, 2);
  assert.deepEqual({ connection: sets[1].connection, latitude: sets[1].latitude, longitude: sets[1].longitude, reconnecting: sets[1].reconnecting }, { connection: 'remote', latitude: 1, longitude: 2, reconnecting: true });
});
