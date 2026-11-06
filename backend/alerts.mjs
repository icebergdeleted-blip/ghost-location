// SPDX-License-Identifier: GPL-3.0-or-later
const LOST = new Set(['waiting', 'unknown']);
const label = connection => connection === 'remote' ? 'remote' : connection === 'wifi' ? 'Wi-Fi' : 'USB';

/**
 * Desktop alerts for a live location losing (and regaining) its phone connection.
 * Honest wording: while disconnected Ghost cannot see the phone, so the text never says
 * "restored" or "still spoofed". Normal Restore and quitting never alert.
 */
export class ConnectionAlerts {
  constructor() { this.previous = null; this.lost = null; this.suppressed = false; }
  suppress() { this.suppressed = true; }

  update(state) {
    const previous = this.previous, next = state?.session ?? null;
    this.previous = next ? { deviceId: next.deviceId, status: next.status, connection: next.connection, deviceName: next.deviceName, autoReconnect: next.autoReconnect } : null;
    if (this.suppressed || !previous || !next || previous.deviceId !== next.deviceId) {
      if (!next) this.lost = null;
      return null;
    }
    const phone = next.deviceName || 'Your phone';
    if (previous.status === 'active' && LOST.has(next.status)) {
      this.lost = next.deviceId;
      return {
        kind: 'lost',
        title: `${phone}: connection lost`,
        body: next.autoReconnect
          ? `The ${label(next.connection)} connection dropped. Ghost keeps retrying. If it can’t reconnect, the phone returns to its real location within about a minute.`
          : `The ${label(next.connection)} connection dropped. Reconnect the phone in Ghost, then retry or restore.`,
      };
    }
    if (this.lost === next.deviceId && previous.status !== 'active' && next.status === 'active') {
      this.lost = null;
      return { kind: 'reconnected', title: `${phone}: reconnected`, body: 'Ghost is sending your location again.' };
    }
    return null;
  }
}
