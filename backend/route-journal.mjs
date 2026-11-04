// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { measurePath } from './routing.mjs';
import { place, speedMph } from './validation.mjs';

const STATUSES = new Set(['starting', 'running', 'paused', 'completed']);

/**
 * Route geometry and progress, kept beside settings.json so a route can be resumed
 * manually after Ghost restarts. This file never decides anything about a phone.
 * The settings journal's session record stays the safety record. A route is restored
 * only when it belongs to that record's phone, and it always comes back paused.
 */
export class RouteJournal {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); }

  static validate(value) {
    if (value?.schemaVersion !== 1 || !value.route || !value.progress) throw new Error('Unsupported route journal.');
    const { route, progress } = value;
    if (typeof route.id !== 'string' || !Array.isArray(route.waypoints) || route.waypoints.length < 2 || route.waypoints.length > 12) throw new Error('Invalid saved route.');
    const path = measurePath(route.coordinates);
    const traveled = Number(progress.traveledMeters);
    if (typeof progress.deviceId !== 'string' || !Number.isFinite(traveled) || traveled < 0 || !STATUSES.has(progress.status)) throw new Error('Invalid saved route progress.');
    return {
      route: { id: route.id, waypoints: route.waypoints.map(p => place(p)), coordinates: path.coordinates,
        distanceMeters: path.distanceMeters, durationSeconds: route.durationSeconds, speedMph: speedMph(route.speedMph ?? 45) },
      progress: { deviceId: progress.deviceId, status: progress.status, traveledMeters: Math.min(traveled, path.distanceMeters),
        speedMph: speedMph(progress.speedMph ?? 45), savedAt: progress.savedAt },
      path,
    };
  }

  async load() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return RouteJournal.validate(JSON.parse(raw));
  }

  save(route, progress) {
    const snapshot = JSON.stringify({ schemaVersion: 1,
      route: { id: route.id, waypoints: route.waypoints, coordinates: route.coordinates, distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds, speedMph: route.speedMph },
      progress });
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
  }

  clear() { return this.enqueue(() => rm(this.path, { force: true })); }

  enqueue(fn) {
    const operation = this.queue.catch(() => {}).then(fn);
    this.queue = operation;
    return operation;
  }
}
