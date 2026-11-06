import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PhoneControl, isTailnetAddress, localTailscaleIPv4 } from '../backend/phone-control.mjs';

const phone = { id: 'ios:00008140-000244AE1132801C', name: 'Test iPhone', state: 'ready', connection: 'remote' };

function fakeController() {
  const calls = [];
  const state = { busy: false, session: null, route: null, devices: [phone], savedPlaces: [{ id: 'x', label: 'Home', latitude: 1, longitude: 2 }] };
  return {
    calls, state,
    snapshot: () => structuredClone(state),
    applyLocation: async input => { calls.push(['apply', input]); state.session = { deviceId: input.deviceId, status: 'active', label: input.label, latitude: input.latitude, longitude: input.longitude, deviceName: 'Test iPhone', connection: 'remote' }; },
    stopLocation: async () => { calls.push(['stop']); state.session = null; },
  };
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-phone-'));
  const controller = fakeController();
  let clock = 1_000_000;
  const control = new PhoneControl({ controller, dataPath: path.join(dir, 'phone-control.json'), port: 0, address: () => '127.0.0.1',
    allowAddress: () => true, now: () => clock, ...options });
  t.after(async () => { await control.stop(); await rm(dir, { recursive: true, force: true }); });
  await control.start();
  const origin = `http://127.0.0.1:${control.port}`;
  let cookie = '';
  const call = (method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(`${origin}${pathname}`, { method, headers: {
      ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        const set = res.headers['set-cookie']?.[0];
        if (set) cookie = set.split(';')[0];
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { control, controller, call, dir, advance: ms => { clock += ms; }, forgetCookie: () => { cookie = ''; } };
}

test('tailnet address checks accept only Tailscale ranges', () => {
  for (const ip of ['100.64.0.1', '100.123.126.110', '100.127.255.254', '::ffff:100.100.1.1', 'fd7a:115c:a1e0::5']) assert.equal(isTailnetAddress(ip), true, ip);
  for (const ip of ['100.63.0.1', '100.128.0.1', '192.168.1.5', '127.0.0.1', '10.0.0.1', 'fe80::1', '', null]) assert.equal(isTailnetAddress(ip), false, String(ip));
  assert.equal(localTailscaleIPv4(() => ({ Wi: [{ family: 'IPv4', internal: false, address: '10.101.0.5' }], Tailscale: [{ family: 'IPv4', internal: false, address: '100.79.113.80' }] })), '100.79.113.80');
  assert.equal(localTailscaleIPv4(() => ({ Wi: [{ family: 'IPv4', internal: false, address: '10.101.0.5' }] })), null);
});

test('without Tailscale the server refuses to start and explains why', async () => {
  const control = new PhoneControl({ controller: fakeController(), dataPath: path.join(os.tmpdir(), 'unused.json'), address: () => null });
  await assert.rejects(control.start(), /Tailscale is not connected/);
  assert.equal(control.status().enabled, false);
});

test('requests from outside the tailnet or for another host name are refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('GET', '/', undefined, { Host: 'evil.example:7420' })).status, 403, 'DNS rebinding guard');
  f.control.allowAddress = () => false;
  assert.equal((await f.call('GET', '/')).status, 403, 'non-tailnet peer');
});

test('the page loads but every API needs a paired phone', async t => {
  const f = await fixture(t);
  const page = await f.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await f.call('GET', '/vendor/leaflet.js')).status, 200);
  assert.equal((await f.call('GET', '/api/state')).status, 401);
  assert.equal((await f.call('POST', '/api/set', { latitude: 1, longitude: 2 })).status, 401);
  assert.equal((await f.call('GET', '/../package.json')).status, 404);
  assert.deepEqual(f.controller.calls, []);
});

test('pairing: 6-digit code, expires, locks after 5 wrong tries, and stores only token hashes', async t => {
  const f = await fixture(t);
  assert.match((await f.call('POST', '/api/pair', { code: '000000' })).json.error, /No pairing code/);
  const { code } = f.control.newPairingCode().pairing;
  assert.match(code, /^\d{6}$/);
  const wrong = code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 4; i++) assert.match((await f.call('POST', '/api/pair', { code: wrong })).json.error, /not right/);
  assert.match((await f.call('POST', '/api/pair', { code: wrong })).json.error, /Too many wrong codes/);
  assert.match((await f.call('POST', '/api/pair', { code })).json.error, /No pairing code/, 'the locked code no longer works');
  const fresh = f.control.newPairingCode().pairing.code;
  f.advance(5 * 60_000 + 1);
  assert.match((await f.call('POST', '/api/pair', { code: fresh })).json.error, /No pairing code/, 'codes expire after 5 minutes');
  const good = f.control.newPairingCode().pairing.code;
  const paired = await f.call('POST', '/api/pair', { code: good });
  assert.equal(paired.status, 200);
  assert.match(paired.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const token = paired.headers['set-cookie'][0].split(';')[0].split('=')[1];
  const disk = await readFile(path.join(f.dir, 'phone-control.json'), 'utf8');
  assert.ok(!disk.includes(token), 'raw session token is never written to disk');
  assert.equal(f.control.status().phones, 1);
  assert.equal((await f.call('POST', '/api/pair', { code: good })).status, 400, 'a code works once');
});

test('a paired phone can see status, set and restore through the controller; cross-site posts are refused', async t => {
  const f = await fixture(t);
  await f.call('POST', '/api/pair', { code: f.control.newPairingCode().pairing.code });
  const state = await f.call('GET', '/api/state');
  assert.deepEqual(state.json.devices, [{ id: phone.id, name: 'Test iPhone', connection: 'remote' }]);
  assert.equal(state.json.savedPlaces[0].label, 'Home');
  assert.equal((await f.call('POST', '/api/set', { latitude: 1, longitude: 2 }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.call('POST', '/api/set', 'latitude=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.match((await f.call('POST', '/api/set', { latitude: 95, longitude: 2 })).json.error, /latitude/);
  f.advance(1001);
  const set = await f.call('POST', '/api/set', { latitude: 40.689247, longitude: -74.044502, label: 'Liberty' });
  assert.equal(set.status, 200);
  assert.equal(set.json.session.status, 'active');
  assert.deepEqual(f.controller.calls[0], ['apply', { latitude: 40.689247, longitude: -74.044502, label: 'Liberty', deviceId: phone.id }]);
  assert.equal((await f.call('POST', '/api/restore', {})).status, 429, 'commands are rate-limited');
  f.advance(1001);
  assert.equal((await f.call('POST', '/api/restore', {})).json.session, null);
  assert.deepEqual(f.controller.calls.at(-1), ['stop']);
  assert.equal((await f.call('POST', '/api/set', 'x'.repeat(5000))).status, 413);
});

test('signing out all phones revokes existing sessions immediately', async t => {
  const f = await fixture(t);
  await f.call('POST', '/api/pair', { code: f.control.newPairingCode().pairing.code });
  assert.equal((await f.call('GET', '/api/state')).status, 200);
  await f.control.revokeAll();
  assert.equal((await f.call('GET', '/api/state')).status, 401);
  assert.equal(f.control.status().phones, 0);
});

test('no phone connected to Ghost gives a clear error instead of a command', async t => {
  const f = await fixture(t);
  f.controller.state.devices = [];
  await f.call('POST', '/api/pair', { code: f.control.newPairingCode().pairing.code });
  f.advance(1001);
  assert.match((await f.call('POST', '/api/set', { latitude: 1, longitude: 2 })).json.error, /No phone is connected/);
  assert.deepEqual(f.controller.calls, []);
});

test('the MagicDNS name works alongside the IP; other names are still refused; QR link carries the code in the fragment', async t => {
  const f = await fixture(t, { dnsName: async () => 'laptop.tail1234.ts.net' });
  const status = f.control.status();
  assert.equal(status.url, `http://laptop.tail1234.ts.net:${f.control.port}`);
  assert.equal(status.ipUrl, `http://127.0.0.1:${f.control.port}`);
  assert.equal((await f.call('GET', '/', undefined, { Host: `laptop.tail1234.ts.net:${f.control.port}` })).status, 200);
  assert.equal((await f.call('GET', '/', undefined, { Host: `evil.ts.net:${f.control.port}` })).status, 403);
  const { pairing } = f.control.newPairingCode();
  assert.equal(pairing.url, `${status.url}/#pair=${pairing.code}`);
  const named = `http://laptop.tail1234.ts.net:${f.control.port}`;
  const paired = await f.call('POST', '/api/pair', { code: pairing.code }, { Host: `laptop.tail1234.ts.net:${f.control.port}`, Origin: named });
  assert.equal(paired.status, 200, 'pairing through the friendly name');
  assert.equal((await f.call('POST', '/api/restore', {}, { Host: `laptop.tail1234.ts.net:${f.control.port}`, Origin: `http://127.0.0.1:${f.control.port}` })).status, 403,
    'Origin must match the host actually used');
  assert.equal((await f.call('GET', '/manifest.webmanifest')).status, 200);
  assert.equal((await f.call('GET', '/icon.png')).headers['content-type'], 'image/png');
});

test('search goes through Ghost’s geocoder: paired only, validated, rate-limited, results cleaned', async t => {
  const queries = [];
  const f = await fixture(t, { search: async q => { queries.push(q); return [
    { label: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502, extra: 'dropped' },
    { label: 'bad', latitude: 999, longitude: 0 },
  ]; } });
  assert.equal((await f.call('GET', '/api/search?q=liberty')).status, 401);
  await f.call('POST', '/api/pair', { code: f.control.newPairingCode().pairing.code });
  assert.match((await f.call('GET', '/api/search?q=a')).json.error, /two characters/);
  const result = await f.call('GET', '/api/search?q=%20liberty%20');
  assert.deepEqual(result.json, [{ label: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502 }], 'invalid results are dropped, extra fields removed');
  assert.equal((await f.call('GET', '/api/search?q=liberty')).status, 429, 'one search per second');
  f.advance(1001);
  assert.equal((await f.call('GET', '/api/search?q=liberty')).status, 200);
  assert.deepEqual(queries, ['liberty', 'liberty']);
});

test('search returns label and coordinates only', async t => {
  const f = await fixture(t, { search: async () => [{ label: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502, osm: 'x' }] });
  await f.call('POST', '/api/pair', { code: f.control.newPairingCode().pairing.code });
  assert.deepEqual((await f.call('GET', '/api/search?q=liberty')).json, [{ label: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502 }]);
});
