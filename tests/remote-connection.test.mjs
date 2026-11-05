import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { IosAdapter } from '../backend/ios.mjs';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';
import { remoteHost } from '../backend/validation.mjs';

const UDID = '00008140-000244AE1132801C';
const usbPhone = { id: `ios:${UDID}`, serial: UDID, platform: 'ios', name: 'Test iPhone', connection: 'usb', state: 'ready' };

function harness() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { requests.push(JSON.parse(chunk)); done(); } });
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  const adapter = new IosAdapter({ runner: () => child });
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  return { child, requests, adapter, reply };
}

test('remote address must be an IP literal: no names, ports or URLs', () => {
  assert.equal(remoteHost(' 100.123.126.110 '), '100.123.126.110');
  assert.equal(remoteHost('fd7a:115c:a1e0::1'), 'fd7a:115c:a1e0::1');
  for (const bad of ['', 'phone.ts.net', '100.64.0.1:49152', 'http://100.64.0.1', null, 42, '1'.repeat(80)]) {
    assert.throws(() => remoteHost(bad), /remote IP address/);
  }
});

test('remote discovery asks only the configured phone at the configured address', async () => {
  const h = harness(); h.adapter.connection = 'remote';
  assert.deepEqual(await h.adapter.list(), [], 'unconfigured remote never probes the network');
  assert.equal(h.requests.length, 0);
  h.adapter.remote = { host: '100.123.126.110', udid: UDID };
  const listing = h.adapter.list();
  await new Promise(setImmediate);
  assert.deepEqual(h.requests[0].params, { connection: 'remote', host: '100.123.126.110', udid: UDID });
  const remotePhone = { ...usbPhone, connection: 'remote' };
  h.reply(h.requests[0], [remotePhone, { ...usbPhone, connection: 'usb' }]);
  assert.deepEqual(await listing, [remotePhone]);
  h.child.kill();
});

test('remote commands carry the host and refuse a phone that was not set up', async () => {
  const h = harness(); h.adapter.connection = 'remote';
  const remotePhone = { ...usbPhone, connection: 'remote' };
  assert.throws(() => h.adapter.deviceParams(remotePhone), /Set up remote access/);
  h.adapter.remote = { host: '100.123.126.110', udid: 'SOMEOTHERPHONE01' };
  assert.throws(() => h.adapter.deviceParams(remotePhone), /Set up remote access/);
  h.adapter.remote = { host: '100.123.126.110', udid: UDID };
  assert.deepEqual(h.adapter.deviceParams(remotePhone), { udid: UDID, connection: 'remote', host: '100.123.126.110' });
});

test('remote access setup is USB-only', async () => {
  const h = harness();
  await assert.rejects(h.adapter.pairRemote({ ...usbPhone, connection: 'wifi' }), /by USB/);
  assert.equal(h.requests.length, 0);
});

async function controllerFixture(preferences = {}) {
  const data = defaults(); Object.assign(data.preferences, preferences);
  const store = { load: async () => structuredClone(data), save: async value => Object.assign(data, structuredClone(value)) };
  const calls = [];
  const ios = { status: async () => ({ available: true }), list: async () => [usbPhone], pairRemote: async device => calls.push(['pairRemote', device.id]),
    dispose: async () => {} };
  const c = new Controller({ adapters: { ios }, store });
  await c.init();
  return { c, ios, data, calls };
}

test('remote connection needs setup and an address; settings reach the adapter', async () => {
  const f = await controllerFixture();
  await assert.rejects(f.c.setConnection('remote'), /Set up remote access/);
  await f.c.updatePreferences({ remoteHost: '100.123.126.110' });
  assert.equal(f.data.preferences.remoteHost, '100.123.126.110');
  assert.deepEqual(f.ios.remote, { host: '100.123.126.110', udid: null });
  await assert.rejects(f.c.setConnection('remote'), /Set up remote access/);
  await f.c.pairRemote(usbPhone.id);
  assert.deepEqual(f.calls, [['pairRemote', usbPhone.id]]);
  assert.equal(f.data.preferences.remoteUdid, UDID);
  assert.deepEqual(f.ios.remote, { host: '100.123.126.110', udid: UDID });
  f.ios.list = async () => [];
  await f.c.setConnection('remote');
  assert.equal(f.ios.connection, 'remote');
  await assert.rejects(f.c.updatePreferences({ remoteHost: 'phone.ts.net' }), /remote IP address/);
  await assert.rejects(f.c.setConnection('bluetooth'), /Choose USB, Wi-Fi or remote/);
});

test('remote preferences survive restart and an unknown saved connection falls back to USB', async () => {
  const restored = await controllerFixture({ connection: 'remote', remoteHost: '100.64.0.9', remoteUdid: UDID });
  assert.equal(restored.ios.connection, 'remote');
  assert.deepEqual(restored.ios.remote, { host: '100.64.0.9', udid: UDID });
  const corrupt = await controllerFixture({ connection: 'carrier-pigeon' });
  assert.equal(corrupt.ios.connection, 'usb');
});

test('the remote address cannot change under a live remote session', async () => {
  const f = await controllerFixture({ connection: 'remote', remoteHost: '100.64.0.9', remoteUdid: UDID });
  f.c.state.session = { id: 's', deviceId: usbPhone.id, platform: 'ios', status: 'active', connection: 'remote' };
  await assert.rejects(f.c.updatePreferences({ remoteHost: '100.64.0.10' }), /Restore the current location/);
  await assert.rejects(f.c.updatePreferences({ remoteHost: null }), /Restore the current location/);
  await f.c.updatePreferences({ remoteHost: '100.64.0.9' }); // unchanged address is fine
});
