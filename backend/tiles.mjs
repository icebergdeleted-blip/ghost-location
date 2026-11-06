// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RASTER_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_ZOOM = 22;

/** Parse and bound z/x/y. Returns null for anything that is not a real tile address. */
export function tileAddress(z, x, y) {
  const [zoom, column, row] = [z, x, y].map(value => (/^\d{1,8}$/.test(String(value)) ? Number(value) : NaN));
  if (!Number.isInteger(zoom) || zoom > MAX_ZOOM) return null;
  const size = 2 ** zoom;
  if (!Number.isInteger(column) || !Number.isInteger(row) || column >= size || row >= size) return null;
  return { z: zoom, x: column, y: row };
}

/** Sniff the real image type rather than trusting metadata. */
export function imageType(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Local raster tiles for offline maps: an MBTiles file (SQLite, TMS rows) or an
 * XYZ folder ({z}/{x}/{y}.png|jpg|webp). Vector tiles are rejected, because the
 * Leaflet map can only draw raster images.
 */
export class TileSource {
  constructor({ sqlite = null } = {}) { this.sqlite = sqlite; this.kind = 'online'; this.db = null; this.root = null; this.info = null; }

  async configure(kind, location) {
    this.close();
    if (kind === 'online' || !kind) { this.kind = 'online'; this.info = null; return null; }
    if (typeof location !== 'string' || !path.isAbsolute(location)) throw new Error('Choose an offline tile file or folder.');
    if (kind === 'mbtiles') return this.openMbtiles(location);
    if (kind === 'folder') return this.openFolder(location);
    throw new Error('Unknown map tile source.');
  }

  async openMbtiles(file) {
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('The MBTiles file was not found.');
    const { DatabaseSync } = this.sqlite || await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const metadata = Object.fromEntries(db.prepare('SELECT name, value FROM metadata').all().map(row => [row.name, row.value]));
      const format = String(metadata.format || 'png').toLowerCase();
      if (format === 'pbf' || format === 'mvt') throw new Error('This MBTiles file has vector tiles. Ghost needs raster tiles (PNG, JPEG or WebP).');
      if (!RASTER_TYPES[format]) throw new Error(`Unsupported MBTiles tile format: ${format}.`);
      const zooms = db.prepare('SELECT MIN(zoom_level) AS minzoom, MAX(zoom_level) AS maxzoom FROM tiles').get();
      if (zooms?.maxzoom == null) throw new Error('The MBTiles file contains no tiles.');
      this.tileQuery = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
      this.db = db; this.kind = 'mbtiles';
      this.info = { kind: 'mbtiles', name: String(metadata.name || path.basename(file)).slice(0, 120), format,
        minzoom: Number(zooms.minzoom), maxzoom: Number(zooms.maxzoom), attribution: String(metadata.attribution || '').slice(0, 300) };
      return this.info;
    } catch (error) { db.close(); throw error; }
  }

  async openFolder(folder) {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('The tile folder was not found.');
    this.root = path.resolve(folder); this.kind = 'folder';
    this.info = { kind: 'folder', name: path.basename(folder), format: 'auto', minzoom: 0, maxzoom: 19, attribution: '' };
    return this.info;
  }

  /** @returns {{body: Buffer, contentType: string} | null} */
  async tile(z, x, y) {
    const address = tileAddress(z, x, y);
    if (!address || this.kind === 'online') return null;
    let body = null;
    if (this.kind === 'mbtiles') {
      const row = this.tileQuery.get(address.z, address.x, 2 ** address.z - 1 - address.y); // MBTiles rows are TMS (flipped y)
      body = row?.tile_data ? Buffer.from(row.tile_data) : null;
    } else {
      for (const ext of Object.keys(RASTER_TYPES)) {
        const file = path.resolve(this.root, String(address.z), String(address.x), `${address.y}.${ext}`);
        if (!file.startsWith(this.root + path.sep)) return null;
        try { body = await readFile(file); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (!body) return null;
    const contentType = imageType(body);
    return contentType ? { body, contentType } : null;
  }

  close() {
    try { this.db?.close(); } catch {}
    this.db = null; this.tileQuery = null; this.root = null;
  }
}
