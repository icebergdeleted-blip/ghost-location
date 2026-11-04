// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Hardware persistence probe. Manual use only: it changes a real iPhone's location.
 *
 * Question: does an iOS 17+ simulated location survive after Ghost stops sending
 * (sidecar killed, transport closed, or cable unplugged) and stay until an
 * explicit Restore? See docs/persistence-findings.md for the procedure.
 *
 * DVT steps use Ghost's real IosAdapter -> sidecar/ios_bridge.py path. Restore uses
 * Ghost's real Controller.stopLocation() against a recovery record. That is the same
 * path as Restore after a Ghost restart. Legacy-service and device-fact steps use
 * sidecar/persistence_probe.py. Everything is appended to
 * artifacts/persistence-probe/log.jsonl. Use `report` to print a table for the findings doc.
 *
 * Quit Ghost first. Connect exactly one iPhone by USB. Every mutating command needs --udid.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IosAdapter } from '../backend/ios.mjs';
import { Controller } from '../backend/controller.mjs';
import { Store } from '../backend/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts', 'persistence-probe');
const logPath = path.join(outDir, 'log.jsonl');
const settingsPath = path.join(outDir, 'settings.json');
const python = path.join(root, 'sidecar', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export const CHECKPOINT_MINUTES = [1, 5, 30];
const END_MODES = new Set(['kill', 'close', 'unplug']);
const OBSERVATIONS = new Set(['spoofed', 'real', 'other', 'unclear']);

const usage = `Usage: node scripts/persistence-probe.mjs <command> [options]

  facts      --udid U                         device, DDI and service facts (no location change)
  dvt-set    --udid U --lat N --lon N [--hold S] [--end kill|close|unplug]
             Ghost's real set path. Holds the 1 s loop for S seconds (default 10; 0 = one-shot),
             then ends WITHOUT a clear:
               kill   - hard-kill the sidecar (like a crash)
               close  - close the DVT transport cleanly (Ghost's quit-without-restore)
               unplug - keep looping and wait for you to pull the cable
  restore    --udid U                         Ghost's real Restore (Controller.stopLocation)
  legacy-set --udid U --lat N --lon N [--via usbmux|rsd] [--service NAME]
  legacy-clear --udid U [--via usbmux|rsd] [--service NAME]
  unmount-ddi --udid U                        unmount the developer disk image
  note       --check LABEL --maps spoofed|real|other|unclear [--locked yes|no] [--text "..."]
  schedule                                    print the check times for the last end event
  report                                      print the log as a Markdown table`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value; i++;
  }
  return { command, options };
}

export function validateOptions(command, options) {
  const needsUdid = ['facts', 'dvt-set', 'restore', 'legacy-set', 'legacy-clear', 'unmount-ddi'];
  if (needsUdid.includes(command) && !/^[A-Za-z0-9-]{8,80}$/.test(options.udid || '')) throw new Error('--udid is required (see `facts` or Finder/Apple Devices).');
  if (['dvt-set', 'legacy-set'].includes(command)) {
    const lat = Number(options.lat), lon = Number(options.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) throw new Error('--lat/--lon are invalid.');
  }
  if (command === 'dvt-set') {
    const hold = Number(options.hold ?? 10);
    if (!Number.isFinite(hold) || hold < 0 || hold > 3600) throw new Error('--hold must be 0–3600 seconds.');
    if (!END_MODES.has(options.end ?? 'kill')) throw new Error('--end must be kill, close or unplug.');
  }
  if (command === 'note') {
    if (!options.check) throw new Error('--check is required, e.g. 1m, 5m, 30m, after-restore, after-reboot.');
    if (!OBSERVATIONS.has(options.maps)) throw new Error('--maps must be spoofed, real, other or unclear.');
    if (options.locked && !['yes', 'no'].includes(options.locked)) throw new Error('--locked must be yes or no.');
  }
  return true;
}

export function checkpoints(endedAt, minutes = CHECKPOINT_MINUTES) {
  const start = Date.parse(endedAt);
  return minutes.map(m => ({ label: `${m}m`, at: new Date(start + m * 60_000).toISOString() }));
}

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
export function report(entries) {
  const rows = entries.map(e => {
    const { ts, step, ...rest } = e;
    return `| ${cell(ts)} | ${cell(step)} | ${cell(JSON.stringify(rest))} |`;
  });
  return ['| Time (UTC) | Step | Details |', '| --- | --- | --- |', ...rows].join('\n');
}

async function log(step, details = {}) {
  const entry = { ts: new Date().toISOString(), step, ...details };
  await mkdir(outDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`);
  console.log(`[${entry.ts}] ${step} ${JSON.stringify(details)}`);
  return entry;
}

async function readLog() {
  try { return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function helper(args) {
  if (!existsSync(python)) throw new Error('Create sidecar/.venv first (npm run runtime:ios, or python -m venv + pip install -r sidecar/requirements.txt).');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-u', path.join(root, 'sidecar', 'persistence_probe.py'), ...args],
      { cwd: path.join(root, 'sidecar'), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.once('error', reject);
    child.once('exit', code => {
      const lines = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
      resolve({ code, lines, stderr: stderr.trim() });
    });
  });
}

function printSchedule(endedAt, connected) {
  console.log(`\nThe phone has received no location command since ${endedAt}.`);
  console.log(connected ? 'Leave the cable CONNECTED for this test.' : 'UNPLUG the cable now if it is still connected.');
  console.log('Use a target far from your real position. Check Apple Maps (tap the location arrow) at:');
  for (const point of checkpoints(endedAt)) console.log(`  ${point.label.padEnd(4)} ${new Date(point.at).toLocaleTimeString()}  →  node scripts/persistence-probe.mjs note --check ${point.label} --maps spoofed|real|other|unclear --locked yes|no`);
  console.log('Keep Maps open and the phone unlocked until the 1m check. Then lock it until each later check.');
  console.log('Record each check with `note`. When finished, reconnect and run `restore`.');
}

function probeRecord(device, latitude, longitude, sessionId, status, message) {
  return { id: sessionId, deviceId: device.id, platform: 'ios', deviceName: device.name, serial: device.serial, connection: 'usb',
    latitude, longitude, label: 'Persistence probe', status, autoReconnect: false, message, startedAt: new Date().toISOString() };
}

async function saveRecord(session) {
  const store = new Store(settingsPath);
  const data = await store.load();
  await store.save({ ...data, session });
}

async function findDevice(adapter, udid) {
  const status = await adapter.status();
  if (!status.available) throw new Error(`iPhone runtime unavailable: ${status.message}`);
  const devices = await adapter.list();
  const device = devices.find(d => d.id === `ios:${udid}`);
  if (!device) throw new Error(`iPhone ${udid} is not connected by USB. Found: ${devices.map(d => d.id).join(', ') || 'none'}`);
  if (device.state !== 'ready') throw new Error(`iPhone is ${device.state}: ${device.detail}`);
  if (devices.length > 1) throw new Error('Connect only one iPhone for this probe.');
  return { device, status };
}

async function dvtSet({ udid, lat, lon, hold = '10', end = 'kill' }) {
  const latitude = Number(lat), longitude = Number(lon), holdSeconds = Number(hold);
  let ended = null; let acks = 0;
  const adapter = new IosAdapter({ rootPath: root,
    onLocationRefresh: () => { acks++; },
    onSessionEnd: event => { ended ??= { at: new Date().toISOString(), error: event.error }; } });
  adapter.connection = 'usb';
  try {
    const { device, status } = await findDevice(adapter, udid);
    const sessionId = randomUUID();
    // Same order as Ghost: journal a recovery record before mutating the phone.
    await saveRecord(probeRecord(device, latitude, longitude, sessionId, 'applying', 'Probe is setting a location.'));
    await log('dvt-set:start', { udid, osVersion: device.osVersion, runtime: status.message, latitude, longitude, holdSeconds, end });
    const result = await adapter.set(device, { latitude, longitude, sessionId });
    await log('dvt-set:acknowledged', { refreshedAt: result.refreshedAt, refreshCount: result.refreshCount });
    await saveRecord(probeRecord(device, latitude, longitude, sessionId, 'unknown', 'Probe left this location without a clear. Run restore.'));

    if (end === 'unplug') {
      console.log('\nLoop is running. UNPLUG THE CABLE NOW. Waiting up to 10 minutes for the disconnect…');
      const deadline = Date.now() + 600_000;
      while (!ended && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
      if (!ended) throw new Error('No disconnect was detected within 10 minutes.');
      await log('dvt-set:disconnect-detected', { acks, error: ended.error });
      adapter.terminate('probe: cable removed; sidecar stopped without a clear');
      printSchedule(ended.at, false);
      return;
    }
    const until = Date.now() + holdSeconds * 1000;
    while (Date.now() < until && !ended) await new Promise(r => setTimeout(r, 100));
    if (ended) throw new Error(`Transport ended during hold: ${ended.error}`);
    if (end === 'kill') adapter.terminate('probe: sidecar killed without a clear');
    else await adapter.dispose({ restore: false });
    const endedAt = new Date().toISOString();
    await log('dvt-set:ended-without-clear', { mode: end, acksDuringHold: acks });
    printSchedule(endedAt, true);
    console.log('\nFor the unplugged variant: keep this result, then UNPLUG and keep checking at the same times.');
  } finally {
    if (!adapter.closed) adapter.terminate('probe exiting without a clear');
  }
}

async function restore({ udid }) {
  // A fresh Controller, like a new Ghost process: it did not create the spoof.
  // It only knows the recovery record and matches the device by UDID.
  let data;
  try { data = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { data = null; }
  if (!data?.session || data.session.deviceId !== `ios:${udid}`) {
    await saveRecord({ id: randomUUID(), deviceId: `ios:${udid}`, platform: 'ios', deviceName: 'iPhone', serial: udid, connection: 'usb',
      latitude: 0, longitude: 0, label: 'Probe restore without record', status: 'unknown', autoReconnect: false, message: 'Restore-only probe.' });
  }
  let controller;
  const adapter = new IosAdapter({ rootPath: root,
    onSessionEnd: event => controller?.sessionEnded(event), onLocationRefresh: event => controller?.locationRefreshed(event) });
  controller = new Controller({ adapters: { ios: adapter }, store: new Store(settingsPath) });
  try {
    await controller.init();
    if (!controller.state.session) throw new Error('The recovery record was discarded (another phone connected?). Nothing was sent.');
    await log('restore:start', { udid, recordStatus: controller.state.session.status, devices: controller.state.devices.map(d => `${d.id}:${d.state}`) });
    try {
      await controller.stopLocation();
      await log('restore:result', { cleared: controller.state.session === null,
        meaning: 'stopLocationSimulation was written (no-reply selector). Verify real location in Maps, then run note --check after-restore.' });
    } catch (error) {
      await log('restore:result', { cleared: false, error: error.message, record: controller.state.session?.status });
      process.exitCode = 1;
    }
  } finally {
    await controller.dispose({ restore: false });
  }
}

async function legacyOrFacts(command, options) {
  const args = [command, '--udid', options.udid];
  for (const key of ['lat', 'lon', 'via', 'service']) if (options[key] != null) args.push(`--${key}`, String(options[key]));
  const result = await helper(args);
  const entry = result.lines.find(line => line.command === command) || {};
  await log(command, { ...options, ok: entry.ok === true, result: entry.result, error: entry.error,
    warning: result.lines.find(l => l.warning)?.warning, exit: result.code, ...(entry.ok ? {} : { stderr: result.stderr.slice(-800) }) });
  if (command === 'legacy-set' && entry.ok) {
    const endedAt = new Date().toISOString();
    printSchedule(endedAt, true);
  }
  if (!entry.ok) process.exitCode = 1;
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help') { console.log(usage); return; }
  validateOptions(command, options);
  if (command === 'dvt-set') return dvtSet(options);
  if (command === 'restore') return restore(options);
  if (['facts', 'legacy-set', 'legacy-clear', 'unmount-ddi'].includes(command)) return legacyOrFacts(command, options);
  if (command === 'note') {
    await log('observation', { check: options.check, maps: options.maps, locked: options.locked, text: options.text });
    return;
  }
  if (command === 'schedule') {
    const last = (await readLog()).filter(e => /ended-without-clear|disconnect-detected|^legacy-set$/.test(e.step)).at(-1);
    if (!last) throw new Error('No end event logged yet.');
    for (const point of checkpoints(last.ts)) console.log(`${point.label}\t${new Date(point.at).toLocaleString()}`);
    return;
  }
  if (command === 'report') { console.log(report(await readLog())); return; }
  throw new Error(`Unknown command ${command}.\n${usage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`persistence-probe: ${error.message}`); process.exitCode = 1; });
}
