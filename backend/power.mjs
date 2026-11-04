// SPDX-License-Identifier: GPL-3.0-or-later

// While a phone is being driven, or Ghost is about to reconnect it, the computer
// must not suspend: sleep would stop the location loop mid-session. An unresolved
// record that needs the user (unknown/error) does not hold the machine awake.
// Neither does no session at all, which is the state after a successful Restore.
const HOLD_STATUSES = new Set(['active', 'applying', 'reconnecting', 'stopping']);

export function wantsWakeLock(state) {
  const session = state?.session;
  if (!session) return false;
  if (HOLD_STATUSES.has(session.status)) return true;
  return session.status === 'waiting' && session.autoReconnect === true;
}

/** Keeps one OS power-save blocker in step with controller state. */
export class WakeLock {
  constructor(blocker) { this.blocker = blocker; this.id = null; }
  update(state) {
    const wanted = wantsWakeLock(state);
    if (wanted && this.id == null) this.id = this.blocker.start('prevent-app-suspension');
    else if (!wanted && this.id != null) this.release();
    return this.id != null;
  }
  release() {
    if (this.id == null) return;
    try { this.blocker.stop(this.id); } finally { this.id = null; }
  }
}
