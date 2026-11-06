// SPDX-License-Identifier: GPL-3.0-or-later
// Launches the real Electron app with isolated settings that select a local MBTiles
// file, and checks that the map draws tiles from ghost://app/tiles with no tile
// server on the network. Read-only USB discovery only; no phone commands.
import { _electron } from 'playwright';
import electronPath from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { defaults } from '../backend/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'ghost-tiles-'));
const mbtiles = path.join(userData, 'test-area.mbtiles');
// A valid 1x1 PNG, stored for every tile from zoom 0 to 3.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const db = new DatabaseSync(mbtiles);
db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
for (const [name, value] of [['name', 'Ghost test area'], ['format', 'png'], ['attribution', 'Test tiles']]) db.prepare('INSERT INTO metadata VALUES (?, ?)').run(name, value);
const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
for (let z = 0; z <= 3; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) insert.run(z, x, y, png);
db.close();
const settings = defaults();
Object.assign(settings.preferences, { onboardingComplete: true, hostPlatform: 'windows', phonePlatform: 'ios', tileSource: 'mbtiles', tilePath: mbtiles });
await writeFile(path.join(userData, 'settings.json'), JSON.stringify(settings));

const env = { ...process.env, GHOST_TEST_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${userData}`], cwd: root, env, timeout: 30000 });
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  // Prove independence from the network tile server: block it outright.
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  const info = await page.evaluate(() => window.ghost.getTileInfo());
  assert.equal(info.kind, 'mbtiles', JSON.stringify(info));
  assert.equal(info.error, null);
  await page.waitForFunction(() => [...document.querySelectorAll('img.leaflet-tile')].some(img => img.src.startsWith('ghost://app/tiles/') && img.complete && img.naturalWidth === 1));
  const sources = await page.evaluate(() => [...document.querySelectorAll('img.leaflet-tile')].map(img => img.src));
  assert.ok(sources.every(src => src.startsWith('ghost://app/tiles/')), `Unexpected tile sources: ${sources.slice(0, 3)}`);
  const missing = await page.evaluate(() => new Promise(resolve => { const img = new Image(); img.onload = () => resolve('loaded'); img.onerror = () => resolve('missing'); img.src = 'ghost://app/tiles/9/0/0'; }));
  assert.equal(missing, 'missing', 'Tiles outside the file must not load.');
  const traversal = await page.evaluate(() => fetch('ghost://app/tiles/../settings.json').then(r => r.status, () => 'blocked'));
  assert.notEqual(traversal, 200);
  await page.evaluate(() => document.querySelector('#settings-button').click());
  assert.match(await page.locator('#tile-status').textContent(), /Offline MBTiles: Ghost test area · zoom 0–3/);
  console.log(`PASS: ${sources.length} tile image(s) drawn from the local MBTiles file with the OpenStreetMap tile server blocked; out-of-range tiles refused.`);
} finally {
  await application.close();
}
