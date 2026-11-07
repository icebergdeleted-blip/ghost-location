// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMMANDS, GhostServer, controlSocketPath, dataDirectory, requestAdmin } from '../server/main.mjs';

const quiet = { info() {}, warn() {}, error() {} };

function fakeController({ session = null, restoreOnQuit = true, stopFails = false } = {}) {
  const controller = new EventEmitter();
  Object.assign(controller, {
    state: { session, busy: false, preferences: { restoreOnQuit } }, calls: [],
    async init() { this.calls.push('init'); }, notify() {}, async scanDevices() {},
    async stopLocation() {
      this.calls.push('stopLocation');
      if (stopFails) throw new Error('The phone is not connected.');
      this.state.session = null;
    },
    async sessionEnded(event) { this.calls.push(['sessionEnded', event.retry, event.error]); },
    async dispose(options) { this.calls.push(['dispose', options.restore]); },
  });
  return controller;
}

function fakePhoneControl({ failures = 0 } = {}) {
  const phone = new EventEmitter();
  Object.assign(phone, {
    attempts: 0, running: false,
    async start() {
      this.attempts++;
      if (this.attempts <= failures) throw new Error('Tailscale is not connected on this computer.');
      this.running = true;
      return { url: 'http://pi.tailnet.ts.net:7420', ipUrl: 'http://100.81.200.95:7420' };
    },
    async stop() { this.running = false; return {}; },
    status() { return { enabled: this.running }; },
    newPairingCode() {
      if (!this.running) throw new Error('Turn phone control on first.');
      return { pairing: { code: '123456', url: 'http://pi.tailnet.ts.net:7420/#pair=123456', expiresAt: 1 } };
    },
    async revokeAll() { return { phones: 0 }; },
  });
  return phone;
}

// Timers are recorded instead of scheduled, so retry logic is checked without waiting.
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn) => { const handle = { fn }; pending.push(handle); return handle; },
    clearTimer: (handle) => { handle.cleared = true; },
    setRepeat: () => ({ repeat: true }), clearRepeat: () => {},
  };
}

test('the data folder follows GHOST_DATA_DIR, then XDG_DATA_HOME, then ~/.local/share', () => {
  assert.equal(dataDirectory({ GHOST_DATA_DIR: '/srv/ghost' }, '/home/pi'), path.resolve('/srv/ghost'));
  assert.equal(dataDirectory({ XDG_DATA_HOME: '/data' }, '/home/pi'), path.join(path.resolve('/data'), 'ghost'));
  assert.equal(dataDirectory({}, '/home/pi'), path.join('/home/pi', '.local', 'share', 'ghost'));
  assert.equal(controlSocketPath('/home/pi/.local/share/ghost', 'linux'), path.join('/home/pi/.local/share/ghost', 'control.sock'));
});

test('phone control keeps retrying until Tailscale is up, and a pairing code needs it running', async () => {
  const timers = manualTimers();
  const phone = fakePhoneControl({ failures: 2 });
  const server = new GhostServer({ controller: fakeController(), phoneControl: phone, log: quiet, ...timers });
  await server.start();
  await assert.rejects(server.command('pair'), /Turn phone control on first/);
  assert.equal(phone.attempts, 1);
  await timers.pending.shift().fn(); // second attempt fails and schedules a third
  assert.equal(phone.attempts, 2);
  await timers.pending.shift().fn();
  assert.equal(phone.attempts, 3);
  assert.equal(timers.pending.length, 0);
  assert.equal((await server.command('pair')).code, '123456');
  await assert.rejects(server.command('reboot'), /Unknown command/);
});

test('stopping restores a live session when Restore-on-quit is on', async () => {
  const controller = fakeController({ session: { deviceId: 'ios:A', status: 'active' } });
  const server = new GhostServer({ controller, phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await server.start();
  await server.stop();
  assert.equal(controller.calls.filter(call => call === 'stopLocation').length, 1);
  assert.ok(!controller.calls.some(call => call[0] === 'sessionEnded'));
});

test('if restoring fails on stop, the session keeps its recovery record and is never called restored', async () => {
  const controller = fakeController({ session: { deviceId: 'ios:A', status: 'active' }, stopFails: true });
  const logged = [];
  const log = { info: m => logged.push(m), warn: m => logged.push(m) };
  const server = new GhostServer({ controller, phoneControl: fakePhoneControl(), log, ...manualTimers() });
  await server.start();
  await Promise.all([server.stop(), server.stop()]); // a second signal must not run shutdown twice
  assert.equal(controller.calls.filter(call => call === 'stopLocation').length, 1);
  const ended = controller.calls.find(call => call[0] === 'sessionEnded');
  assert.equal(ended[1], false);
  assert.match(ended[2], /without confirming restoration/);
  assert.ok(!logged.some(line => /^Restored/.test(line)));
  assert.ok(logged.some(line => /recovery record is kept/.test(line)));
});

test('with Restore-on-quit off, stopping keeps the session for recovery without sending Restore', async () => {
  const controller = fakeController({ session: { deviceId: 'ios:A', status: 'active' }, restoreOnQuit: false });
  const server = new GhostServer({ controller, phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await server.start();
  await server.stop();
  assert.ok(!controller.calls.includes('stopLocation'));
  assert.equal(controller.calls.find(call => call[0] === 'sessionEnded')[1], false);
});

test('the local admin socket answers pair and status, and refuses a second server', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghost-server-'));
  const socketPath = controlSocketPath(dir);
  const make = () => new GhostServer({ controller: fakeController(), phoneControl: fakePhoneControl(), log: quiet, socketPath, ...manualTimers() });
  const server = make();
  try {
    await server.start();
    assert.equal((await requestAdmin(socketPath, 'pair')).code, '123456');
    assert.equal((await requestAdmin(socketPath, 'status')).session, null);
    await assert.rejects(requestAdmin(socketPath, 'nope'), /Unknown command/);
    if (process.platform !== 'win32') await assert.rejects(make().start(), /already running/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupController(devices) {
  const controller = fakeController();
  Object.assign(controller.state, { devices, preferences: { restoreOnQuit: true, connection: 'usb' } });
  Object.assign(controller, {
    async setConnection(value) { if (!['usb', 'wifi', 'remote'].includes(value)) throw new Error('Choose USB, Wi-Fi or remote.'); this.state.preferences.connection = value; },
    async prepareDevice(id) { this.calls.push(['prepare', id]); },
    async pairRemote(id) { this.calls.push(['pairRemote', id]); this.state.preferences.remoteUdid = id.slice(4); },
    async updatePreferences(value) { this.state.preferences = { ...this.state.preferences, ...value }; },
    async findTailscalePhones() { return [{ name: 'iPhone', ip: '100.123.126.110', online: true }]; },
  });
  return controller;
}
const iphone = { id: 'ios:UDID1', serial: 'UDID1', name: 'iPhone', platform: 'ios', connection: 'usb', state: 'ready' };
const pixel = { id: 'android:P1', serial: 'P1', name: 'Pixel', platform: 'android', connection: 'usb', state: 'ready' };

test('setup commands pick the only phone, or need an id when several are connected', async () => {
  const one = setupController([iphone]);
  const server = new GhostServer({ controller: one, phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await server.command('prepare');
  assert.deepEqual(one.calls.at(-1), ['prepare', 'ios:UDID1']);
  assert.equal((await server.command('devices')).devices[0].id, 'ios:UDID1');

  const two = new GhostServer({ controller: setupController([iphone, pixel]), phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await assert.rejects(two.command('prepare'), /More than one phone/);
  await two.command('prepare', 'P1');
  await assert.rejects(two.command('prepare', 'nope'), /No phone nope/);
  const none = new GhostServer({ controller: setupController([]), phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await assert.rejects(none.command('prepare'), /No phone found/);
});

test('remote setup needs a USB iPhone, then the address and connection are set from the CLI', async () => {
  const controller = setupController([pixel, { ...iphone, connection: 'wifi' }]);
  const server = new GhostServer({ controller, phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await assert.rejects(server.command('setup-remote'), /No phone found/); // Android and Wi-Fi iPhones are skipped
  controller.state.devices = [pixel, iphone];
  assert.equal((await server.command('setup-remote')).remoteUdid, 'UDID1');
  assert.equal((await server.command('find-iphones')).iphones[0].ip, '100.123.126.110');
  assert.equal((await server.command('remote-address', '100.123.126.110')).remoteHost, '100.123.126.110');
  assert.equal((await server.command('connection', 'remote')).connection, 'remote');
  await assert.rejects(server.command('connection', 'bluetooth'), /Choose USB, Wi-Fi or remote/);
});

test('restore from the CLI reports only what the clear command proved', async () => {
  const idle = new GhostServer({ controller: fakeController(), phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  assert.equal((await idle.command('restore')).restored, false);
  const ok = new GhostServer({ controller: fakeController({ session: { deviceId: 'ios:A' } }), phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  assert.equal((await ok.command('restore')).restored, true);
  const failing = fakeController({ session: { deviceId: 'ios:A' }, stopFails: true });
  const bad = new GhostServer({ controller: failing, phoneControl: fakePhoneControl(), log: quiet, ...manualTimers() });
  await assert.rejects(bad.command('restore'), /not connected/);
  assert.ok(failing.state.session, 'the session record stays when Restore fails');
});

test('admin requests carry arguments and long commands get long client timeouts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghost-server-'));
  const socketPath = controlSocketPath(dir);
  const controller = setupController([iphone]);
  const server = new GhostServer({ controller, phoneControl: fakePhoneControl(), log: quiet, socketPath, ...manualTimers() });
  try {
    await server.start();
    assert.equal((await requestAdmin(socketPath, 'remote-address 100.123.126.110')).remoteHost, '100.123.126.110');
    assert.equal((await requestAdmin(socketPath, 'connection wifi')).connection, 'wifi');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(COMMANDS.prepare[1] >= 10 * 60_000 && COMMANDS['setup-remote'][1] >= 10 * 60_000);
});

test('the systemd service lets Ghost restore before its iPhone helper is stopped', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(path.join(process.cwd(), 'scripts/linux/install-service.sh'), 'utf8');
  assert.match(script, /^KillMode=mixed$/m); // SIGTERM to Ghost only; the helper must still be alive to send Restore
  assert.match(script, /^TimeoutStopSec=(\d+)$/m);
  assert.ok(Number(script.match(/^TimeoutStopSec=(\d+)$/m)[1]) >= 60);
  assert.match(script, /^ExecStart=\$node \$ghost_dir\/server\/main\.mjs$/m);
});
