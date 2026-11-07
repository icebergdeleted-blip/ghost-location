#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Ghost headless server: the desktop backend without Electron, for an always-on Linux host
// such as a Raspberry Pi. The phone page (backend/phone-control.mjs) is the only interface.
//
//   node server/main.mjs          run the server (systemd starts this)
//   node server/main.mjs pair     ask the running server for a 6-digit pairing code
//   node server/main.mjs status   show the server's phone-control and session status
//   node server/main.mjs revoke   sign out every paired phone
//   node server/main.mjs help     list the iPhone setup commands (devices, prepare, setup-remote, …)
import { createConnection, createServer } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEOCODER = 'https://photon.komoot.io/api/';

/** Settings live here: GHOST_DATA_DIR, else $XDG_DATA_HOME/ghost, else ~/.local/share/ghost. */
export function dataDirectory(env = process.env, home = homedir()) {
  if (env.GHOST_DATA_DIR) return path.resolve(env.GHOST_DATA_DIR);
  return path.join(env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, '.local', 'share'), 'ghost');
}

/** The local admin socket. Only this user can open it (directory 0700, socket 0600). */
export function controlSocketPath(dataDir, platform = process.platform) {
  // Windows has no Unix socket files; a per-directory named pipe keeps tests portable.
  if (platform === 'win32') return `\\\\.\\pipe\\ghost-${Buffer.from(dataDir).toString('hex').slice(-40)}`;
  return path.join(dataDir, 'control.sock');
}

const RETRY_MS = 15_000;
const LONG_MS = 15 * 60_000; // Prepare may download the developer image first
/** Admin commands and how long the CLI waits for each. */
export const COMMANDS = {
  pair: ['Show a 6-digit pairing code and QR link for the phone page.', 5000],
  status: ['Phone control and current session.', 5000],
  revoke: ['Sign out every paired phone.', 5000],
  devices: ['List phones Ghost can see on the current connection.', 30_000],
  connection: ['Show or choose the connection: usb, wifi or remote.', 60_000],
  prepare: ['Prepare a phone (developer image). Usage: prepare [phone-id]', LONG_MS],
  'setup-remote': ['One-time remote access setup for a USB iPhone. Usage: setup-remote [phone-id]', LONG_MS],
  'find-iphones': ["List iPhones in this computer's Tailscale network.", 30_000],
  'remote-address': ["Show or set the iPhone's Tailscale address. Usage: remote-address [100.x.y.z]", 5000],
  restore: ["Restore the phone's real location now.", 120_000],
};
const BUSY_WAIT_MS = 30_000;

/**
 * Runs Ghost's Controller and PhoneControl without a window. Safety rules match the desktop app:
 * Restore stays possible, a session that could not be restored keeps its recovery record, and
 * nothing reports "restored" unless the restore command itself succeeded.
 */
export class GhostServer {
  constructor({ controller, phoneControl, alerts = null, log = console, socketPath, pollMs = 2000, retryMs = RETRY_MS,
    busyWaitMs = BUSY_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
    Object.assign(this, { controller, phoneControl, alerts, log, socketPath, pollMs, retryMs, busyWaitMs, setTimer, clearTimer, setRepeat, clearRepeat });
    this.poll = null; this.retry = null; this.admin = null; this.stopping = null;
  }

  async start() {
    this.controller.on('state', state => {
      const alert = this.alerts?.update(state);
      if (alert) this.log.warn(`[alert] ${alert.title}: ${alert.body}`);
    });
    this.phoneControl.on?.('paired', () => this.log.info('A phone paired with Ghost.'));
    await this.controller.init();
    this.controller.notify();
    this.poll = this.setRepeat(() => this.controller.scanDevices().catch(error => {
      this.controller.state.warning = error.message; this.controller.notify();
    }), this.pollMs);
    await this.listenAdmin();
    await this.startPhoneControl();
  }

  /** Phone control is this server's only interface, so keep trying until Tailscale is up. */
  async startPhoneControl() {
    if (this.stopping) return;
    try {
      const status = await this.phoneControl.start();
      this.log.info(`Phone control is on: ${status.url}${status.ipUrl && status.ipUrl !== status.url ? ` (or ${status.ipUrl})` : ''}`);
      this.log.info('Get a pairing code with: node server/main.mjs pair');
    } catch (error) {
      this.log.warn(`${error.message} Trying again in ${Math.round(this.retryMs / 1000)} s.`);
      this.retry = this.setTimer(() => { this.retry = null; this.startPhoneControl(); }, this.retryMs);
    }
  }

  /** A phone by id, or the only phone on this connection when no id is given. */
  pickDevice(id, filter = () => true) {
    const devices = this.controller.state.devices.filter(filter);
    if (id) {
      const device = devices.find(item => item.id === id || item.serial === id);
      if (!device) throw new Error(`No phone ${id} here. Run devices to see the list.`);
      return device;
    }
    if (devices.length === 1) return devices[0];
    throw new Error(devices.length ? 'More than one phone is connected. Add its id (see devices).'
      : 'No phone found. Plug it in, unlock it, trust this computer, then run devices.');
  }

  /** Admin commands from the local CLI (see COMMANDS). */
  async command(name, arg = '') {
    const { controller } = this;
    if (name === 'devices') {
      await controller.scanDevices();
      return { connection: controller.state.preferences.connection || 'usb',
        devices: controller.state.devices.map(({ id, name: label, platform, connection, state, detail }) =>
          ({ id, name: label, platform, connection, state, detail: detail || null })) };
    }
    if (name === 'connection') {
      if (arg) await controller.setConnection(arg);
      return { connection: controller.state.preferences.connection || 'usb' };
    }
    if (name === 'prepare') {
      await controller.prepareDevice(this.pickDevice(arg).id);
      return { prepared: true };
    }
    if (name === 'setup-remote') {
      const device = this.pickDevice(arg, item => item.platform === 'ios' && item.connection === 'usb');
      await controller.pairRemote(device.id);
      return { remoteUdid: controller.state.preferences.remoteUdid, next: 'Set the address with remote-address, unplug, then run: connection remote' };
    }
    if (name === 'find-iphones') return { iphones: await controller.findTailscalePhones() };
    if (name === 'remote-address') {
      if (arg) await controller.updatePreferences({ remoteHost: arg }); // validated like the desktop field
      return { remoteHost: controller.state.preferences.remoteHost || null, remoteUdid: controller.state.preferences.remoteUdid || null };
    }
    if (name === 'restore') {
      if (!controller.state.session) return { restored: false, message: 'No phone location is being simulated.' };
      await controller.stopLocation(); // throws if the clear command fails, so success is never claimed then
      return { restored: !controller.state.session };
    }
    if (name === 'pair') {
      const status = this.phoneControl.newPairingCode(); // throws if phone control is not on yet
      return { code: status.pairing.code, url: status.pairing.url, expiresAt: status.pairing.expiresAt };
    }
    if (name === 'status') {
      const { session } = this.controller.state;
      return { phoneControl: this.phoneControl.status(),
        session: session ? { deviceId: session.deviceId, status: session.status, connection: session.connection ?? null } : null };
    }
    if (name === 'revoke') return this.phoneControl.revokeAll();
    throw new Error(`Unknown command. Use one of: ${Object.keys(COMMANDS).join(', ')}.`);
  }

  async listenAdmin() {
    if (!this.socketPath) return;
    if (process.platform !== 'win32') {
      // A socket left by a crash blocks listen(); remove it only if nothing answers on it.
      if (await requestAdmin(this.socketPath, 'status', 1000).then(() => true, () => false)) {
        throw new Error('Another Ghost server is already running for this data folder.');
      }
      await rm(this.socketPath, { force: true });
    }
    const server = createServer(socket => {
      let input = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy()); // only until the request line arrives
      socket.on('data', chunk => {
        if (input.includes('\n')) return;
        input += chunk;
        if (input.length > 256) return socket.destroy();
        if (!input.includes('\n')) return;
        socket.setTimeout(0); // Prepare can run for minutes
        const [name, ...rest] = input.trim().split(/\s+/);
        this.command(name, rest.join(' ')).then(data => ({ ok: true, data }), error => ({ ok: false, error: error.message }))
          .then(reply => socket.end(`${JSON.stringify(reply)}\n`));
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.socketPath, resolve); });
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600);
    this.admin = server;
  }

  /** systemd stop / Ctrl+C. Mirrors the desktop quit: restore if set to, otherwise keep the record. */
  stop() {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  async shutdown() {
    this.alerts?.suppress(); // stopping ends sessions on purpose; never alert about it
    if (this.retry) this.clearTimer(this.retry);
    this.clearRepeat(this.poll);
    await this.phoneControl.stop().catch(() => {});
    if (this.admin) await new Promise(resolve => this.admin.close(() => resolve()));
    const deadline = Date.now() + this.busyWaitMs;
    while (this.controller.state.busy && Date.now() < deadline) await new Promise(resolve => this.setTimer(resolve, 250));
    const { controller } = this;
    if (controller.state.session && controller.state.preferences.restoreOnQuit && !controller.state.busy) {
      try {
        await controller.stopLocation();
        this.log.info('Restored the phone location before stopping.');
      } catch (error) {
        this.log.warn(`The phone location was not restored: ${error.message}`);
      }
    }
    if (controller.state.session) {
      this.log.warn('A phone session is still unresolved. Its recovery record is kept; use Restore after Ghost starts again.');
      await controller.sessionEnded({ deviceId: controller.state.session.deviceId, retry: false,
        error: 'Ghost stopped without confirming restoration. Reconnect this phone and choose Retry location or Restore.' });
    }
    await Promise.race([controller.dispose({ restore: false }), new Promise(resolve => this.setTimer(resolve, 6000))]);
  }
}

/** Sends one admin command to a running server. */
export function requestAdmin(socketPath, name, timeoutMs = COMMANDS[name.split(' ')[0]]?.[1] ?? 5000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Ghost server did not answer.')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${name}\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(output);
        reply.ok ? resolve(reply.data) : reject(new Error(reply.error));
      } catch { reject(new Error('Ghost server sent an unreadable reply.')); }
    });
  });
}

async function runServer() {
  const [{ Store }, { Controller }, { Geocoder }, { IosAdapter }, { AndroidAdapter }, { wifiStatus }, { RouteJournal },
    { ConnectionAlerts }, { PhoneControl }, { findSelfDnsName }] = await Promise.all([
    import('../backend/store.mjs'), import('../backend/controller.mjs'), import('../backend/geocoder.mjs'), import('../backend/ios.mjs'),
    import('../backend/android.mjs'), import('../backend/network.mjs'), import('../backend/route-journal.mjs'),
    import('../backend/alerts.mjs'), import('../backend/phone-control.mjs'), import('../backend/tailscale.mjs')]);
  const dataDir = dataDirectory();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const options = { rootPath, resourcesPath: path.join(rootPath, 'resources') };
  let controller;
  const callbacks = { onSessionEnd: event => controller?.sessionEnded(event), onLocationRefresh: event => controller?.locationRefreshed(event) };
  controller = new Controller({ adapters: { ios: new IosAdapter({ ...options, ...callbacks }), android: new AndroidAdapter({ ...options, ...callbacks }) },
    network: wifiStatus, store: new Store(path.join(dataDir, 'settings.json')), routeJournal: new RouteJournal(path.join(dataDir, 'route.json')) });
  const geocoder = new Geocoder();
  const port = /^\d{4,5}$/.test(process.env.GHOST_PHONE_CONTROL_PORT || '') ? Number(process.env.GHOST_PHONE_CONTROL_PORT) : undefined;
  const phoneControl = new PhoneControl({ controller, dataPath: path.join(dataDir, 'phone-control.json'), ...(port ? { port } : {}),
    dnsName: () => findSelfDnsName().catch(() => null),
    search: query => { geocoder.configure(controller.state.preferences.geocoderUrl || GEOCODER); return geocoder.search(query); } });
  const server = new GhostServer({ controller, phoneControl, alerts: new ConnectionAlerts(), socketPath: controlSocketPath(dataDir) });
  let signalled = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (signalled) return;
    signalled = true;
    console.info('Stopping Ghost…');
    server.stop().catch(error => console.error(error.message)).finally(() => process.exit(0));
  });
  console.info(`Ghost server, data in ${dataDir}`);
  await server.start();
}

function printHelp() {
  console.log('Usage: node server/main.mjs [command]   (no command starts the server)\n');
  for (const [name, [about]] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(15)} ${about}`);
}

async function runCommand(name, args) {
  if (name === 'help' || name === '--help') return printHelp();
  if (!COMMANDS[name]) { printHelp(); throw new Error(`Unknown command: ${name}`); }
  if (['prepare', 'setup-remote'].includes(name)) console.log('Working… keep the phone unlocked. This can take a few minutes the first time.');
  const data = await requestAdmin(controlSocketPath(dataDirectory()), [name, ...args].join(' ')).catch(error => {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('The Ghost server is not running (or uses another data folder; check GHOST_DATA_DIR).');
    throw error;
  });
  if (name === 'pair') {
    console.log(`Pairing code: ${data.code} (valid for 5 minutes, works once)`);
    console.log(`Or open this on your phone: ${data.url}`);
  } else if (name === 'devices') {
    console.log(`Connection: ${data.connection}`);
    if (!data.devices.length) console.log('No phones found.');
    for (const item of data.devices) console.log(`  ${item.id}  ${item.name} (${item.platform}, ${item.connection}) ${item.state}${item.detail ? ` – ${item.detail}` : ''}`);
  } else console.log(JSON.stringify(data, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  (name ? runCommand(name, process.argv.slice(3)) : runServer()).catch(error => { console.error(error.message); process.exit(1); });
}
