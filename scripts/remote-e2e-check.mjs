// SPDX-License-Identifier: GPL-3.0-or-later
// Manual hardware check (changes a real iPhone's location briefly, then restores it).
// Runs Ghost's real Controller -> IosAdapter -> sidecar in the "remote" connection mode.
// Usage: node scripts/remote-e2e-check.mjs --udid UDID --host 100.x.y.z [--seconds 8]
// Requires: remote access set up over USB once (RemotePairing record), developer image mounted
// since the last iPhone restart, and the iPhone joined to Wi-Fi with Tailscale on.
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IosAdapter } from '../backend/ios.mjs';
import { Controller } from '../backend/controller.mjs';
import { Store } from '../backend/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const udid = arg('udid'), host = arg('host'), seconds = Number(arg('seconds') || 8);
if (!/^[A-Za-z0-9-]{8,80}$/.test(udid || '') || !host) throw new Error('Need --udid and --host.');
const log = (step, detail = {}) => console.log(new Date().toISOString().slice(11, 23), step, JSON.stringify(detail));

const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-remote-e2e-'));
let controller;
const ios = new IosAdapter({ rootPath: root,
  onSessionEnd: event => { log('session-ended', { error: event.error }); controller?.sessionEnded(event); },
  onLocationRefresh: event => controller?.locationRefreshed(event) });
controller = new Controller({ adapters: { ios }, store: new Store(path.join(dir, 'settings.json')) });
try {
  await controller.init();
  // The RemotePairing record already exists (created over USB); record which phone it belongs to.
  controller.state.preferences.remoteUdid = udid;
  await controller.updatePreferences({ remoteHost: host });
  await controller.setConnection('remote');
  let phone;
  for (let attempt = 1; attempt <= 3 && !phone; attempt++) {
    await controller.scanDevices();
    phone = controller.state.devices.find(d => d.id === `ios:${udid}`);
    log('scan', { attempt, found: Boolean(phone), state: phone?.state, connection: phone?.connection });
  }
  if (!phone) throw new Error('iPhone not reachable remotely.');
  const started = Date.now();
  await controller.applyLocation({ deviceId: phone.id, latitude: 40.689247, longitude: -74.044502, label: 'Remote e2e check' });
  log('set', { status: controller.state.session?.status, ms: Date.now() - started });
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  log('after-hold', { status: controller.state.session?.status, refreshCount: controller.state.session?.refreshCount, source: controller.state.session?.refreshSource });
  await controller.stopLocation();
  log('restore', { sessionCleared: controller.state.session === null });
} catch (error) {
  log('FAILED', { message: error.message.slice(0, 240), session: controller.state.session?.status });
  process.exitCode = 1;
  if (controller.state.session) await controller.stopLocation().catch(e => log('restore-failed', { message: e.message.slice(0, 200) }));
} finally {
  await controller.dispose({ restore: true });
  await rm(dir, { recursive: true, force: true });
}
