# Changelog

## Unreleased

- Headless server (`npm run server`) for an always-on Linux host such as a Raspberry Pi 5.
  The phone page is its interface; iPhone setup (devices, prepare, setup-remote,
  remote-address, connection, restore) runs from a local command line over SSH. Includes a
  systemd installer and `docs/raspberry-pi.md`.
- Detect Linux Wi-Fi interfaces.

## 0.1.8 (pre-release)

### Remote iPhone connection and phone control

- Connect to an iPhone over RemotePairing on Wi-Fi, and remotely through Tailscale
  (**Remote** mode). Set up once over USB with **Set up remote access**; **Find with
  Tailscale** lists iPhones on the tailnet. Hardware-verified on iOS 27.0.1, including a
  relayed path and an iPhone on a second phone's personal hotspot. Cellular alone is refused
  by iOS, and the spoof reverts about a minute after the connection drops.
- Pin pymobiledevice3 11.50.0; 11.12.4's RemotePairing proof is rejected by iOS 27.
  The sidecar build now records the pinned version instead of a hard-coded one.
- Desktop alerts when a live spoof loses or regains its connection.
- Phone control (off by default): a map page served only on this computer's Tailscale
  address, paired by a 6-digit code or QR link, with search, saved places, Set, Restore and
  Open in Apple Maps. See `docs/phone-control.md`.
- An unresolved session can move to the phone's current connection type; Set works for
  Wi-Fi and Remote phones; long place names no longer push Restore off a phone screen.
- macOS: declare `_remotepairing._tcp` for local-network discovery.

### Offline features (first shipped in the v0.1.7-offline pre-release)

- Add a manual iPhone persistence probe (`scripts/persistence-probe.mjs`,
  `sidecar/persistence_probe.py`) and `docs/persistence-findings.md`. They test
  whether a simulated location survives sidecar exit, transport close, unplug,
  reboot and developer-image unmount, comparing DVT with the legacy
  `com.apple.dt.simulatelocation` service. **Hardware result (iOS 27.0.1): a DVT
  spoof reverts to the real location within a minute of unplugging, so Phase 2
  persistence was not built.**
  Ghost's disconnect behaviour is unchanged: no "persisting" state is added
  until hardware results support it.
- Adjustable route speed (1–120 mph, default 45 mph = 20.1168 m/s), also
  applied to a running route.
- Persist route geometry and progress (`route.json`). After a restart the route
  comes back paused and resumes only through an explicit Resume. Restore deletes it.
- Offline map: a local raster MBTiles file or `{z}/{x}/{y}` folder, served
  through `ghost://app/tiles`, selected in Settings. Vector tiles are refused.
- Configurable OSRM routing URL. Photon and OSRM accept plain HTTP only for
  localhost or private LAN servers.
- Wake lock decision moved to `backend/power.mjs`. It now also holds during
  Restore (`stopping`) and while an automatic same-phone reconnect is pending.
- Add `docs/architecture-notes.md` and `docs/offline-maps.md`.

## 0.1.7

- Offer Switch to Wi-Fi after a working USB session when the computer has an active Wi-Fi interface.
- Replace the active-session connection lock with a same-phone handoff that carries the current point and resumes a running route.
- Keep USB active during wireless discovery; try USB recovery if the new Wi-Fi session fails.
- Add USB-assisted Android Wi-Fi setup and keep manual Android 11+ pairing available.
- Add handoff, recovery, host-network and renderer regression coverage. Physical Wi-Fi handoff still needs device validation.

## 0.1.6

- Add explicit USB and same-network Wi-Fi connection modes on Mac and Windows.
- Enable trusted iPhone Wi-Fi connections after a one-time USB setup; iOS 17.4+ required.
- Pair Android 11+ using Wireless debugging, with separate pairing and connection ports.
- Preserve Android phone identity across changed Wi-Fi ports and reject reused addresses belonging to another phone.
- Keep fixed-location refreshes and one-second route updates over Wi-Fi; pause routes on connection loss.
- Add guided setup, pairing-code cleanup, transport and UI tests. Physical Wi-Fi validation remains pending.

## 0.1.5

- Plan driving routes through 2–12 ordered map/search stops using OSRM and OpenStreetMap roads.
- Move along the full road geometry at 45 mph, sending a coordinate update every second from the Electron main process.
- Add a route line, moving location dot, distance, remaining time, Pause, Resume, and destination hold.
- Pause motion on disconnect, sleep, or delayed USB writes. Same-phone reconnect holds the last attempted point until explicit Resume; Restore cancels playback.
- Reuse the live iPhone connection and Android helper for moving targets without repeating setup every second.
- Add route geometry, timer, lifecycle, adapter, renderer, and real routing-service checks. These do not establish physical phone behavior.

## 0.1.4

- Add a first-run survey for Mac/Windows and iPhone/Android, with a focused USB
  setup checklist for each of the four combinations.
- Save the selected setup locally and make it available again from Setup and Settings.
- Replace the dense green studio interface with a larger, neutral map-first layout,
  restrained glass controls, standard icons, system typography, and clearer status text.
- Exercise all four setup guides in the isolated native smoke test without sending
  phone location commands.

## 0.1.3

- Accept Android 14's nonzero `am stopservice` result only after `dumpsys`
  confirms that both location services stopped.
- Allow Google's official 32-bit Windows `adb.exe` on Windows x64 while keeping
  the bundled Windows iPhone sidecar check strictly x64.
- Verify the real Android adapter and Appium Settings helper on an Android 14
  emulator with two location targets, helper readback, and cleanup. This is
  component coverage; physical USB acceptance still requires an Android phone.

## 0.1.2

- Automatically discard an unresolved `unknown`, `waiting`, or `error` recovery
  record when a different usable USB phone is discovered, allowing the new phone
  to be prepared and have a location set without manual journal cleanup.
- Cancel pending retries and reset the old adapter transport when that record is
  discarded. Ghost does not send Restore to the absent old phone, which may retain
  its simulated location until it is restarted or restored separately.
- Keep `active`, `applying`, `reconnecting`, and `stopping` sessions protected from
  automatic replacement.

## 0.1.1

- Reassert the fixed iPhone location on a one-second loop with awaited DVT command acknowledgements; show acknowledgement time and count without claiming a phone-app GPS measurement.
- Preserve a healthy iPhone connection during discovery polling while fresh acknowledgements continue. Android's helper emits timestamped fixes every two seconds; desktop status identifies helper readback separately.
- Recover the same device and applied target after USB replug within the same running Ghost process. Allow same-phone retry and target updates after a connection failure; application restart still requires manual Retry or Restore.
- Make Restore cancel automatic reconnection, including while offline or recovery is pending, and preserve focused controls during state updates.

These are implementation changes validated with software checks and controlled
transports. They do not establish physical Set/Update/Restore behavior or
phone-app compatibility; see `docs/hardware-test-matrix.md`.
