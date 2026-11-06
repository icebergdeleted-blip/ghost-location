import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { wantsWakeLock, WakeLock } from '../backend/power.mjs';
import { TileSource, tileAddress, imageType } from '../backend/tiles.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test('wake lock is held for live and auto-reconnecting sessions and released on Restore', () => {
  for (const status of ['active', 'applying', 'reconnecting', 'stopping']) assert.equal(wantsWakeLock({ session: { status } }), true, status);
  assert.equal(wantsWakeLock({ session: { status: 'waiting', autoReconnect: true } }), true);
  assert.equal(wantsWakeLock({ session: { status: 'waiting', autoReconnect: false } }), false);
  for (const status of ['unknown', 'error']) assert.equal(wantsWakeLock({ session: { status } }), false, status);
  assert.equal(wantsWakeLock({ session: null }), false);

  const calls = [];
  const lock = new WakeLock({ start: type => { calls.push(['start', type]); return 7; }, stop: id => calls.push(['stop', id]) });
  assert.equal(lock.update({ session: { status: 'applying' } }), true);
  assert.equal(lock.update({ session: { status: 'active' } }), true);
  assert.equal(lock.update({ session: null }), false); // Restore removed the session
  lock.release();
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
});

test('tile addresses are bounded integers', () => {
  assert.deepEqual(tileAddress('3', '7', '0'), { z: 3, x: 7, y: 0 });
  for (const [z, x, y] of [['3', '8', '0'], ['23', '0', '0'], ['-1', '0', '0'], ['1', '0', '1.5'], ['1', '..', '0'], ['1', '0x1', '0']]) assert.equal(tileAddress(z, x, y), null);
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(JPEG), 'image/jpeg');
  assert.equal(imageType(Buffer.from('<svg>')), null);
});

test('folder tiles are served from {z}/{x}/{y} only, never outside the chosen folder', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-tiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'tiles', '2', '1'), { recursive: true });
  await writeFile(path.join(dir, 'tiles', '2', '1', '3.png'), PNG);
  await writeFile(path.join(dir, 'tiles', '2', '1', '2.png'), Buffer.from('not an image'));
  await writeFile(path.join(dir, 'secret.png'), PNG);
  const source = new TileSource();
  await source.configure('folder', path.join(dir, 'tiles'));
  assert.equal((await source.tile('2', '1', '3')).contentType, 'image/png');
  assert.equal(await source.tile('2', '1', '0'), null, 'missing tile');
  assert.equal(await source.tile('2', '1', '2'), null, 'non-image content is refused');
  assert.equal(await source.tile('..', '..', 'secret'), null);
  await assert.rejects(source.configure('folder', 'relative/path'), /Choose/);
  await assert.rejects(source.configure('folder', path.join(dir, 'missing')), /not found/);
});

test('raster MBTiles are read with TMS row flip; vector MBTiles are refused', async t => {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { t.skip('node:sqlite is unavailable in this Node build'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-mbtiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = (file, format) => {
    const db = new sqlite.DatabaseSync(file);
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('format', format);
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('name', 'Test area');
    // XYZ z=2 x=1 y=0 is TMS row 3.
    db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(2, 1, 3, format === 'pbf' ? Buffer.from([0x1a]) : JPEG);
    db.close();
  };
  const raster = path.join(dir, 'area.mbtiles'), vector = path.join(dir, 'vector.mbtiles');
  make(raster, 'jpg'); make(vector, 'pbf');
  const source = new TileSource();
  t.after(() => source.close());
  const info = await source.configure('mbtiles', raster);
  assert.deepEqual({ name: info.name, minzoom: info.minzoom, maxzoom: info.maxzoom, format: info.format }, { name: 'Test area', minzoom: 2, maxzoom: 2, format: 'jpg' });
  assert.equal((await source.tile('2', '1', '0')).contentType, 'image/jpeg');
  assert.equal(await source.tile('2', '1', '3'), null, 'XYZ row 3 is TMS row 0, which is empty');
  await assert.rejects(new TileSource().configure('mbtiles', vector), /vector tiles/);
  await source.configure('online');
  assert.equal(await source.tile('2', '1', '0'), null);
});
