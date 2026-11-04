import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router, measurePath, speedMps, ROUTE_SPEED_MPS, distanceBetween } from '../backend/routing.mjs';
import { RouteJournal } from '../backend/route-journal.mjs';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';
import { isLocalHost, routingUrl, geocoderUrl, speedMph } from '../backend/validation.mjs';

const close = (a, b, epsilon = 0.001) => assert.ok(Math.abs(a - b) < epsilon, `${a} differs from ${b}`);
// About 1.1 km east along the equator, so many seconds of travel before arrival.
const routePath = measurePath([[0, 0], [0.005, 0], [0.01, 0]]);
const plan = { id: 'road', coordinates: routePath.coordinates, distanceMeters: routePath.distanceMeters, durationSeconds: routePath.distanceMeters / ROUTE_SPEED_MPS, speedMph: 45,
  waypoints: [{ latitude: 0, longitude: 0, label: 'Start' }, { latitude: 0, longitude: 0.01, label: 'End' }] };

test('speed conversion: 45 mph stays exactly the original 20.1168 m/s, and the range is bounded', () => {
  assert.equal(speedMps(45), ROUTE_SPEED_MPS);
  close(speedMps(45), 20.1168, 1e-12);
  close(speedMps(10), 4.4704, 1e-12);
  for (const bad of [0, 0.5, 121, -5, NaN, Infinity, '45', null]) assert.throws(() => speedMph(bad), /1 to 120 mph/);
  assert.equal(speedMph(12.345), 12.3);
});

test('local service URLs: HTTP only for this computer or a private LAN', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '10.0.0.2', '192.168.1.20', '172.16.0.1', 'osrm.localhost']) assert.ok(isLocalHost(new URL(`http://${host}/`).hostname), host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1']) assert.equal(isLocalHost(new URL(`http://${host}/`).hostname), false, host);
  assert.equal(routingUrl('http://localhost:5000'), 'http://localhost:5000/');
  assert.equal(routingUrl('https://osrm.example.org/base'), 'https://osrm.example.org/base/');
  assert.equal(geocoderUrl('http://127.0.0.1:2322/api'), 'http://127.0.0.1:2322/api');
  for (const bad of ['http://example.com/', 'ftp://localhost/', 'https://user:pw@example.com/', 'https://example.com/?q=1', 'not a url']) assert.throws(() => routingUrl(bad));
  assert.throws(() => geocoderUrl('http://photon.komoot.io/api/'));
});

test('a configured local OSRM endpoint is used and named in failures; the default hint mentions Settings', async () => {
  const urls = [];
  const router = new Router({ now: () => 5000, baseUrl: 'http://localhost:5000/', fetcher: async url => { urls.push(url); return new Response(JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: routePath.coordinates } }] })); } });
  const result = await router.plan(plan.waypoints, { speedMph: 30 });
  assert.match(urls[0], /^http:\/\/localhost:5000\/route\/v1\/driving\/0,0;0.01,0\?/);
  assert.equal(result.speedMph, 30);
  close(result.durationSeconds, routePath.distanceMeters / speedMps(30));
  const down = new Router({ now: () => 9000, baseUrl: 'http://localhost:5000/', fetcher: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.plan(plan.waypoints), /routing service at localhost:5000 is running/);
  const offline = new Router({ now: () => 9000, fetcher: async () => { throw new Error('ENOTFOUND'); } });
  await assert.rejects(offline.plan(plan.waypoints), /local OSRM routing URL in Settings/);
  assert.throws(() => router.configure('http://example.com/'));
});

async function fixture(t, { journal = null, initial = {} } = {}) {
  const phone = { id: 'ios:USB123', serial: 'USB123', platform: 'ios', name: 'Test phone', connection: 'usb', state: 'ready' };
  let timestamp = 0, devices = [phone];
  const calls = [], data = { ...defaults(), ...structuredClone(initial) };
  const store = { load: async () => structuredClone(data), save: async value => { calls.push(['persist']); Object.assign(data, structuredClone(value)); } };
  const adapter = { status: async () => ({ available: true }), list: async () => devices,
    set: async (device, point) => { calls.push(['set', device.id, { ...point }]); return {}; },
    update: async (device, point) => { calls.push(['update', device.id, { ...point }]); return {}; },
    clear: async () => calls.push(['clear']), reset: async () => calls.push(['reset']), dispose: async () => {} };
  const routerCalls = [];
  const c = new Controller({ adapters: { ios: adapter }, store, routeJournal: journal,
    router: { configure: url => routerCalls.push(['configure', url]), plan: async (stops, options) => { routerCalls.push(['plan', options]); return structuredClone(plan); } },
    clock: () => timestamp, now: () => Date.parse('2026-11-03T12:00:00Z') + timestamp });
  await c.init();
  t.after(() => c.dispose({ restore: false }));
  return { c, phone, calls, data, routerCalls, adapter, advance: ms => { timestamp += ms; }, disconnect: () => { devices = []; }, reconnect: () => { devices = [phone]; } };
}

test('route speed changes motion, remaining time and messages; default remains 45 mph', async t => {
  const f = await fixture(t);
  assert.equal(f.c.state.preferences.routeSpeedMph, 45);
  await f.c.planRoute(plan.waypoints);
  assert.deepEqual(f.routerCalls[0], ['configure', 'https://router.project-osrm.org/']);
  assert.deepEqual(f.routerCalls[1], ['plan', { speedMph: 45 }]);
  await f.c.startRoute({ deviceId: f.phone.id, routeId: plan.id });
  assert.match(f.c.state.route.message, /45 mph/);
  f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  await f.c.updatePreferences({ routeSpeedMph: 90 });
  assert.equal(f.c.state.route.speedMph, 90); assert.match(f.c.state.route.message, /90 mph/);
  close(f.c.state.route.remainingSeconds, (routePath.distanceMeters - ROUTE_SPEED_MPS) / speedMps(90));
  f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS + speedMps(90));
  const last = f.calls.filter(call => call[0] === 'update').at(-1)[2];
  close(distanceBetween([0, 0], [last.longitude, last.latitude]), ROUTE_SPEED_MPS + speedMps(90), 0.01);
  await assert.rejects(f.c.updatePreferences({ routeSpeedMph: 500 }), /1 to 120 mph/);
  assert.equal(f.c.state.preferences.routeSpeedMph, 90);
});

test('routing URL preference is validated and handed to the router', async t => {
  const f = await fixture(t);
  await f.c.updatePreferences({ routingUrl: 'http://192.168.1.50:5000' });
  assert.equal(f.data.preferences.routingUrl, 'http://192.168.1.50:5000/');
  await f.c.planRoute(plan.waypoints);
  assert.deepEqual(f.routerCalls[0], ['configure', 'http://192.168.1.50:5000/']);
  await assert.rejects(f.c.updatePreferences({ routingUrl: 'http://osrm.example.com/' }), /HTTPS/);
});

test('route progress survives restart, comes back paused, and resumes only on explicit Resume', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'route.json');
  const first = await fixture(t, { journal: new RouteJournal(file) });
  await first.c.planRoute(plan.waypoints);
  await first.c.startRoute({ deviceId: first.phone.id, routeId: plan.id });
  for (let i = 0; i < 6; i++) { first.advance(1000); await first.c.tickRoute(); }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.progress.deviceId, first.phone.id);
  assert.equal(saved.route.coordinates.length, 3);
  assert.ok(saved.progress.traveledMeters >= 5 * ROUTE_SPEED_MPS - 0.01, 'checkpointed at least every 5 seconds');
  const journaledPoint = { latitude: first.data.session.latitude, longitude: first.data.session.longitude };
  assert.ok(journaledPoint.longitude > 0, 'session journal follows route progress, not the start');

  // "Crash": a new Controller over the same settings data and route file.
  const second = await fixture(t, { journal: new RouteJournal(file), initial: first.data });
  assert.equal(second.c.state.session.status, 'unknown');
  assert.equal(second.c.state.route.status, 'paused');
  assert.equal(second.c.state.route.restored, true);
  close(second.c.state.route.traveledMeters, saved.progress.traveledMeters);
  assert.equal(second.c.getRoute().id, plan.id);
  second.advance(10_000); await second.c.scanDevices(); await second.c.tickRoute();
  assert.equal(second.calls.filter(call => ['set', 'update'].includes(call[0])).length, 0, 'never resumed automatically');

  await second.c.resumeRoute();
  const resend = second.calls.find(call => call[0] === 'set');
  assert.deepEqual({ latitude: resend[2].latitude, longitude: resend[2].longitude }, journaledPoint);
  assert.equal(second.c.state.route.status, 'running');
  second.advance(1000); await second.c.tickRoute();
  close(second.c.state.route.traveledMeters, saved.progress.traveledMeters + ROUTE_SPEED_MPS);

  await second.c.stopLocation();
  assert.equal(second.c.state.session, null);
  assert.equal(existsSync(file), false, 'Restore removes the saved route');
});

test('a saved route without a matching unresolved session is only a plan, never an active route', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'route.json');
  await new RouteJournal(file).save(plan, { deviceId: 'ios:OTHER', status: 'running', traveledMeters: 100, speedMph: 45 });
  const f = await fixture(t, { journal: new RouteJournal(file) });
  assert.equal(f.c.state.route, null);
  assert.equal(f.c.getRoute().id, plan.id);
  assert.equal(existsSync(file), false);
});

test('a corrupt route file is ignored with a warning and never blocks startup or recovery', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'route.json');
  await writeFile(file, '{"schemaVersion":1,"route":{"id":"x","waypoints":[],"coordinates":[[0,0],[0,999]]},"progress":{}}');
  const session = { id: 's', deviceId: 'ios:USB123', platform: 'ios', serial: 'USB123', connection: 'usb', latitude: 1, longitude: 2, status: 'active' };
  const f = await fixture(t, { journal: new RouteJournal(file), initial: { session } });
  assert.match(f.c.state.warning, /saved route could not be read/);
  assert.equal(f.c.state.session.status, 'unknown', 'the safety record is unaffected');
  assert.equal(f.c.state.route, null);
});

test('route journal validation rejects malformed geometry, devices and progress', () => {
  const good = { schemaVersion: 1, route: plan, progress: { deviceId: 'ios:A', status: 'paused', traveledMeters: 10, speedMph: 45 } };
  assert.equal(RouteJournal.validate(good).progress.traveledMeters, 10);
  close(RouteJournal.validate({ ...good, progress: { ...good.progress, traveledMeters: 1e9 } }).progress.traveledMeters, routePath.distanceMeters);
  for (const bad of [
    { ...good, schemaVersion: 2 },
    { ...good, route: { ...plan, coordinates: [[0, 0]] } },
    { ...good, progress: { ...good.progress, deviceId: 5 } },
    { ...good, progress: { ...good.progress, status: 'teleporting' } },
    { ...good, progress: { ...good.progress, traveledMeters: -1 } },
    { ...good, progress: { ...good.progress, speedMph: 900 } },
  ]) assert.throws(() => RouteJournal.validate(bad));
});
