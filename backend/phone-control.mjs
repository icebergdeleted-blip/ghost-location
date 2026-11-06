// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { place } from './validation.mjs';

export const PHONE_CONTROL_PORT = 7420;
const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const MAX_SESSIONS = 10;
const MAX_BODY = 4096;
const COMMAND_GAP_MS = 1000;
const COOKIE = 'ghost_phone';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** True for Tailscale's IPv4 range (100.64.0.0/10) and IPv6 ULA (fd7a:115c:a1e0::/48). */
export function isTailnetAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
}

/** This computer's Tailscale IPv4, read from its network interfaces (no CLI needed). */
export function localTailscaleIPv4(interfaces = networkInterfaces) {
  for (const list of Object.values(interfaces())) {
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal && isTailnetAddress(item.address)) return item.address;
  }
  return null;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sameText = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const VENDOR = {
  '/vendor/leaflet.js': ['leaflet/dist/leaflet.js', 'text/javascript; charset=utf-8'],
  '/vendor/leaflet.css': ['leaflet/dist/leaflet.css', 'text/css; charset=utf-8'],
};

/**
 * Optional phone web control, reachable only over Tailscale.
 * - Listens on this computer's Tailscale address only; requests must come from a tailnet
 *   address and name exactly that host (DNS-rebinding guard); POSTs must be same-origin.
 * - A phone signs in with a 6-digit code shown on the computer (5 minutes, 5 attempts); it then
 *   holds a random session cookie. Only SHA-256 hashes of session tokens are stored on disk.
 * - Commands go through the same Controller methods as the desktop app.
 */
export class PhoneControl extends EventEmitter {
  constructor({ controller, dataPath, port = PHONE_CONTROL_PORT, address = localTailscaleIPv4, now = Date.now, allowAddress = isTailnetAddress,
    dnsName = async () => null, search = null } = {}) {
    super();
    Object.assign(this, { controller, dataPath, port, address, now, allowAddress, dnsName, search });
    this.server = null; this.host = null; this.error = null; this.name = null; this.lastSearchAt = -Infinity;
    this.code = null; this.sessions = []; this.loaded = false; this.lastCommandAt = -Infinity;
  }

  /** Host headers this server answers to: the Tailscale IP and, if known, the MagicDNS name. */
  allowedHosts() { return [this.host, this.name].filter(Boolean).map(host => `${host}:${this.port}`); }

  status() {
    const url = this.server ? `http://${this.name || this.host}:${this.port}` : null;
    const pairing = this.code && this.code.expiresAt > this.now() ? this.code : null;
    return {
      enabled: Boolean(this.server), url, ipUrl: this.server ? `http://${this.host}:${this.port}` : null, error: this.error,
      // Scanning this opens the page and pairs in one step. The code is in the URL fragment, which browsers never send to servers.
      pairing: pairing ? { code: pairing.value, expiresAt: pairing.expiresAt, url: `${url}/#pair=${pairing.value}` } : null,
      phones: this.sessions.length,
    };
  }

  async load() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await readFile(this.dataPath, 'utf8'));
      this.sessions = (Array.isArray(data.sessions) ? data.sessions : [])
        .filter(item => /^[a-f0-9]{64}$/.test(item?.hash) && Number.isFinite(item.createdAt)).slice(-MAX_SESSIONS);
    } catch { this.sessions = []; }
    this.loaded = true;
  }

  async save() {
    await mkdir(path.dirname(this.dataPath), { recursive: true });
    await writeFile(`${this.dataPath}.tmp`, JSON.stringify({ schemaVersion: 1, sessions: this.sessions }), { mode: 0o600 });
    await rename(`${this.dataPath}.tmp`, this.dataPath);
  }

  async start() {
    await this.load();
    if (this.server) return this.status();
    const host = this.address();
    if (!host) {
      this.error = 'Tailscale is not connected on this computer. Open Tailscale and sign in, then turn phone control on again.';
      throw new Error(this.error);
    }
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) this.json(res, 500, { error: 'Ghost could not complete that request.' }); });
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, host, resolve); })
      .catch(error => {
        this.error = error.code === 'EADDRINUSE' ? `Port ${this.port} is already in use on this computer.` : `Phone control could not start: ${error.message}`;
        throw new Error(this.error);
      });
    this.server = server; this.host = host; this.error = null;
    try { this.name = await this.dnsName(); } catch { this.name = null; }
    this.port = server.address().port; // tests listen on port 0
    return this.status();
  }

  async stop() {
    const server = this.server;
    this.server = null; this.code = null;
    if (server) await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    return this.status();
  }

  newPairingCode() {
    if (!this.server) throw new Error('Turn phone control on first.');
    this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: this.now() + CODE_TTL_MS, attempts: 0 };
    return this.status();
  }

  async revokeAll() {
    await this.load();
    this.sessions = []; this.code = null;
    await this.save();
    return this.status();
  }

  // ---------------------------------------------------------------- HTTP ----

  headers(type) {
    return {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
  }

  json(res, status, body, extra = {}) {
    res.writeHead(status, { ...this.headers('application/json; charset=utf-8'), ...extra });
    res.end(JSON.stringify(body));
  }

  authorized(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    const token = cookie?.slice(COOKIE.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const hash = sha256(token);
    return this.sessions.some(item => sameText(item.hash, hash) && this.now() - item.createdAt < SESSION_MAX_AGE_S * 1000);
  }

  async body(req) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw Object.assign(new Error('Send JSON.'), { status: 415 });
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  async handle(req, res) {
    // Only tailnet peers, and only requests addressed to this computer's own names (blocks DNS rebinding).
    if (!this.allowAddress(req.socket.remoteAddress) || !this.allowedHosts().includes(req.headers.host)) {
      res.writeHead(403, this.headers('text/plain; charset=utf-8')); res.end('Forbidden'); return;
    }
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && STATIC[url.pathname]) return this.file(res, path.join(here, 'phone', STATIC[url.pathname][0]), STATIC[url.pathname][1]);
    if (req.method === 'GET' && VENDOR[url.pathname]) return this.file(res, require.resolve(VENDOR[url.pathname][0]), VENDOR[url.pathname][1]);
    if (!url.pathname.startsWith('/api/')) { this.json(res, 404, { error: 'Not found.' }); return; }
    if (req.method === 'POST' && req.headers.origin !== origin) { this.json(res, 403, { error: 'Cross-site request refused.' }); return; }
    try {
      if (req.method === 'POST' && url.pathname === '/api/pair') return await this.pair(req, res);
      if (!this.authorized(req)) { this.json(res, 401, { error: 'Pair this phone first.' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/state') { this.json(res, 200, this.publicState()); return; }
      if (req.method === 'GET' && url.pathname === '/api/search') { this.json(res, 200, await this.searchPlaces(url.searchParams.get('q'))); return; }
      if (req.method === 'POST' && (url.pathname === '/api/set' || url.pathname === '/api/restore')) {
        const input = await this.body(req);
        const point = url.pathname === '/api/set' ? place(input) : null; // validate before using a command slot
        if (this.now() - this.lastCommandAt < COMMAND_GAP_MS) { this.json(res, 429, { error: 'Wait a moment before sending another command.' }); return; }
        this.lastCommandAt = this.now();
        if (point) await this.set(point);
        else await this.controller.stopLocation();
        this.json(res, 200, this.publicState()); return;
      }
      this.json(res, 404, { error: 'Not found.' });
    } catch (error) {
      this.json(res, error.status || 400, { error: String(error.message || 'Request failed.').slice(0, 300) });
    }
  }

  async file(res, file, type) {
    const data = await readFile(file);
    res.writeHead(200, this.headers(type)); res.end(data);
  }

  async pair(req, res) {
    const { code } = await this.body(req);
    const current = this.code;
    if (!current || current.expiresAt <= this.now()) { this.json(res, 400, { error: 'No pairing code is active. Choose “Pair a phone” on the computer.' }); return; }
    if (typeof code !== 'string' || !sameText(code.trim(), current.value)) {
      current.attempts += 1;
      if (current.attempts >= CODE_ATTEMPTS) this.code = null;
      this.json(res, 400, { error: this.code ? 'That code is not right. Check the computer and try again.' : 'Too many wrong codes. Create a new code on the computer.' });
      return;
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    this.sessions = [...this.sessions, { hash: sha256(token), createdAt: this.now() }].slice(-MAX_SESSIONS);
    await this.save();
    this.emit('paired');
    this.json(res, 200, { paired: true }, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`,
    });
  }

  async searchPlaces(query) {
    if (!this.search) throw Object.assign(new Error('Search is not available.'), { status: 404 });
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw new Error('Type at least two characters.');
    if (this.now() - this.lastSearchAt < COMMAND_GAP_MS) throw Object.assign(new Error('Searching too fast. Try again in a moment.'), { status: 429 });
    this.lastSearchAt = this.now();
    const results = await this.search(query.trim());
    const clean = [];
    for (const item of Array.isArray(results) ? results : []) {
      try { const { label, latitude, longitude } = place(item); clean.push({ label, latitude, longitude }); } catch { /* skip invalid result */ }
      if (clean.length === 6) break;
    }
    return clean;
  }

  publicState() {
    const state = this.controller.snapshot();
    const session = state.session;
    return {
      busy: Boolean(state.busy),
      session: session ? {
        status: session.status, label: session.label, latitude: session.latitude, longitude: session.longitude,
        message: session.message, deviceName: session.deviceName, connection: session.connection, lastRefreshAt: session.lastRefreshAt,
      } : null,
      route: state.route ? { status: state.route.status, message: state.route.message } : null,
      devices: state.devices.filter(device => device.state === 'ready').map(device => ({ id: device.id, name: device.name, connection: device.connection })),
      savedPlaces: (state.savedPlaces || []).slice(0, 50).map(item => ({ label: item.label, latitude: item.latitude, longitude: item.longitude })),
    };
  }

  async set(input) {
    const point = place(input);
    const state = this.controller.snapshot();
    if (state.route && state.session) throw new Error('A route is running. Restore real location on the computer or phone first.');
    const deviceId = state.session?.deviceId || state.devices.find(device => device.state === 'ready')?.id;
    if (!deviceId) throw new Error('No phone is connected to Ghost on the computer.');
    await this.controller.applyLocation({ ...point, deviceId });
  }
}
