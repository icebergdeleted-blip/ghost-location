# Architecture notes: sessions, the iOS loop, recovery and disconnect

Written for the `feature/offline-persistence` work (fork of Ghost 0.1.7). The
notes describe the code as it stood at commit `5d8d65a`, before this branch's
changes. Line references are approximate.

## Process layout

```
renderer (src/main.js, Leaflet)            sandboxed, contextIsolation
   │  window.ghost.* (electron/preload.cjs)  ← whitelisted IPC methods only
   ▼
Electron main (electron/main.mjs)
   │  ipcMain handlers → Controller; 2 s discovery poll; powerSaveBlocker; quit flow
   ▼
Controller (backend/controller.mjs)        one session, journal, recovery, routes
   ├── Store (backend/store.mjs)           settings.json, atomic tmp+rename writes
   ├── IosAdapter (backend/ios.mjs)        JSONL over stdio to the sidecar
   │      └── sidecar/ios_bridge.py        pymobiledevice3 11.50.0 (pinned), DVT
   └── AndroidAdapter (backend/android.mjs) ADB + Appium Settings helper
```

## How a session is created

`Controller.applyLocation(input)` (`backend/controller.mjs`, about line 279):

1. Validates the point (`backend/validation.mjs`, `place()`) and the device
   (`Controller.device()`: exact id, current connection type, not
   unauthorized/offline).
2. Refuses if a session for a *different* phone exists.
3. Builds a new session record `{id (uuid), deviceId, platform, serial,
   connection, latitude, longitude, label, status: 'applying', …}`.
4. **Journals it before touching the phone** (`persist()` → `Store.save`). A
   failed write aborts without sending anything.
5. Calls `adapter.set(device, {…point, sessionId})`. On success,
   `confirmActive()` sets `status: 'active'` and `autoReconnect: true`, and
   records the acknowledgement time and count. On failure the status becomes
   `unknown` and a same-process retry is scheduled.

Only one unresolved session exists at a time (`state.session`).

## How the iOS sidecar sends location

`IosAdapter.set` (`backend/ios.mjs`) sends one JSON line `{"method":"set",…}`
to `sidecar/ios_bridge.py`. In the sidecar (`Bridge._dispatch`, `set` branch):

1. `connect(udid)` opens a **userspace RSD tunnel** (`UserspaceRsdTunnel`,
   restricted to USB or Wi-Fi by Ghost's `strict_usb_provider` override), then a
   `DvtProvider` and a `LocationSimulation` channel. The tunnel stays open for
   the whole session. A watcher task waits on `dvt.dtx.wait_disconnected()`.
2. `apply_target()` awaits `LocationSimulation.set(lat, lon)`, which is the DTX
   selector `simulateLocationWithLatitude:longitude:`. The selector expects a
   reply, bounded by a 5 s timeout. Only after that reply does the sidecar
   answer `{"applied":true, refreshedAt, refreshCount}`.
3. It then starts `refresh_session()`: **every 1 s**, under the same lock,
   re-send the same target and await the reply. Each reply emits a
   `location-refreshed` event. `IosAdapter` forwards it to
   `Controller.locationRefreshed()`, which updates `lastRefreshAt` and
   `refreshCount` in memory only (not journaled each second).
4. The adapter treats an acknowledgement under 5 s old as proof that the
   phone is present (`IosAdapter.list()`). This keeps a session green during
   flaky usbmux discovery.

**Clear** (`clear` method) sends `stopLocationSimulation`, a DTX selector
with `expects_reply=False`, so "cleared" means only "the command was written".
The sidecar then closes the session.

Upstream's own CLI command `developer dvt simulate-location set` keeps the DVT
connection open until the user presses Enter (`OSUTILS.wait_return()`). That
suggests upstream expects the simulation to be tied to the channel's lifetime,
but it is not proof. See `docs/persistence-findings.md`.

## How recovery records are stored

* There is a single JSON file, `settings.json`, in Electron `userData`
  (`.ghost-dev/` in development). It is written by `Store.save` through a
  serialized queue: write `settings.json.tmp`, then rename it over the original.
  If the file is corrupt, `Store.load` copies it to `settings.json.backup-<ts>`
  and shows a warning.
* Schema 1 has the fields `savedPlaces`, `recentPlaces`, `preferences` and
  `session`, which is the recovery record.
* The session record is journaled on every **state transition**: applying,
  active, waiting/unknown, reconnecting, stopping. Per-second acknowledgements
  and route ticks are not journaled; a route journals only on arrival or pause.
* On startup `Controller.init()` forces any saved session to `status:
  'unknown'` and `autoReconnect: false`. Ghost then needs a manual **Retry
  location** or **Restore** and never resumes on its own.
* If a different usable phone appears while the record is `unknown`, `waiting`
  or `error`, `discardUnresolvedSessionForDifferentPhone()` deletes the record
  and resets the old transport. It does *not* send a clear to the old phone.

## What happens on disconnect today

The disconnect is detected in one of three ways:

* the DVT watcher fires (`wait_disconnected`), giving a `session-ended` event;
* a refresh fails or times out, which also gives `session-ended`;
* two discovery misses in a row with no fresh iOS acknowledgement, in
  `Controller.scan()`.

`Controller.sessionEnded()` then pauses any route motion and marks the session
`waiting` (if the same process can resume it) or `unknown`. The message says
"location state is unknown". The transition is journaled.

While Ghost stays open, `reconnectIfNeeded()` re-sends the same target on the
same phone when it reappears, with backoff. Restore cancels this, even while
the phone is unplugged, and waits for any in-flight recovery to finish first.

After an unplug, nothing in Ghost claims the phone is still spoofed or that it
has been restored. The phone's real state while unplugged is unobserved.

## Quit

`electron/main.mjs` `finishQuit()`: if `restoreOnQuit` is set (the default),
Ghost calls `stopLocation()`. If that fails, a dialog offers *Keep Ghost open*
or *Quit anyway*. Quitting with a session journals it as unresolved, then
calls `dispose({restore:false})`, which closes the transport **without**
sending a clear.

## Wake lock

`electron/main.mjs` already holds
`powerSaveBlocker.start('prevent-app-suspension')` while the session is
`active`, `applying` or `reconnecting`, and releases it otherwise (including
after Restore).
