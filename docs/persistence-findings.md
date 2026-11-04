# Persistence findings: does an iOS spoof survive disconnect?

**Status: primary test run on hardware on 2026-11-04. Result: negative.**
With Ghost's DVT path on an iPhone17,3 running iOS 27.0.1, the simulated
location was gone by the 1-minute check after unplugging (row 4). The
decision rule below is not met, so **Phase 2 ("keep location after cable
disconnect") is stopped**. Ghost keeps its existing behaviour. The other rows
have not been run.

## Hypothesis under test

> On iOS 17+, a location set through the developer services stays after the
> host stops sending and the developer connection closes. It stays until an
> explicit clear (or a reboot).

### What is known before testing (desk research, not proof)

| Source | Observation | Weight |
| --- | --- | --- |
| Ghost 0.1.7 `sidecar/ios_bridge.py` | Ghost re-sends coordinates every 1 s over one long-lived DVT channel. | design choice, not a device fact |
| pymobiledevice3 11.12.4 `cli/developer/dvt/simulate_location.py` | Upstream's `dvt simulate-location set` keeps the channel open (`OSUTILS.wait_return()`) until the user presses Enter. | suggests upstream expects the spoof to end with the channel |
| pymobiledevice3 11.12.4 `services/simulate_location.py` | The legacy `com.apple.dt.simulatelocation` service is fire-and-forget: it writes and returns, with no reply. Upstream CLI help says "iOS versions below 17". | on iOS < 17 this path was designed to be one-shot; iOS 17+ availability unknown |
| pymobiledevice3 11.12.4 `remote/core_device/location_service.py` | CoreDevice `com.apple.coredevice.locationservice` exposes only `available_location_scenarios` in this version. It has no set or clear. | not a usable alternative at the pinned version |
| `stopLocationSimulation` | A DTX selector with `expects_reply=False`. | a clear can be *sent* but is never acknowledged |

## Paths compared

| Path | Code | Transport | Reply? |
| --- | --- | --- | --- |
| **A. DVT LocationSimulation** (Ghost today) | `IosAdapter.set` → `ios_bridge.py` `LocationSimulation.set` | userspace RSD tunnel → DVT | set: yes; clear: no |
| **B. Legacy dt.simulatelocation over usbmux** | `persistence_probe.py legacy-set --via usbmux` | lockdown developer service | none |
| **C. Legacy dt.simulatelocation over RSD** | `persistence_probe.py legacy-set --via rsd [--service NAME]` | RSD tunnel, raw service port | none |
| D. CoreDevice locationservice | not available in 11.12.4 | — | — |

The `facts` step records which of B and C the phone actually advertises.

## Setup

1. **Quit Ghost.** The probe opens its own tunnel.
2. Windows: install **Apple Devices** (Microsoft Store) or iTunes so Apple's USB
   service runs. Without it the probe reports *"Apple USB services are
   unavailable"*. This was observed on the development PC on 2026-11-03.
3. Create the sidecar venv: `npm run runtime:ios`, or
   `python -m venv sidecar/.venv` followed by
   `sidecar/.venv/Scripts/python -m pip install -r sidecar/requirements.txt`.
4. Connect **one** iPhone by USB. Unlock it and trust the computer. Developer
   Mode must be on. Run Ghost's **Prepare** once, or let the probe's first
   `dvt-set` mount the image.
5. Choose a target **far** from your real position (another city), so Maps is
   unambiguous. The examples use Liberty Island `40.689247, -74.044502`.
6. Note your UDID from `facts` or from Finder / Apple Devices.

All output is appended to `artifacts/persistence-probe/log.jsonl`.
`node scripts/persistence-probe.mjs report` prints it as a table to paste below.

## Procedure

Use `P = node scripts/persistence-probe.mjs` and `U = <your UDID>`.

| # | Test | Commands | Then |
| --- | --- | --- | --- |
| 0 | Facts | `P facts --udid U` | Nothing changes on the phone. |
| 1 | Baseline: loop running, cable in | `P dvt-set --udid U --lat 40.689247 --lon -74.044502 --hold 60 --end kill` | Watch Maps during the 60 s hold: it should show the target. When the run ends, the sidecar is killed with no clear. **Leave the cable in.** Check at 1 / 5 / 30 min with `P note …`. |
| 2 | One-shot DVT (no loop), cable in | `P dvt-set … --hold 0 --end kill` | Exactly one set command, then a hard kill. Check at 1 / 5 / 30 min. |
| 3 | Clean transport close, cable in | `P dvt-set … --hold 10 --end close` | This is Ghost's quit-without-restore path. Check at 1 / 5 / 30 min. |
| 4 | **Primary: unplug during loop** | `P dvt-set … --end unplug`, then pull the cable when told | The probe waits for the disconnect event, then stops without a clear. Check at 1 / 5 / 30 min, **unplugged**. |
| 5 | Restore after reconnect | Reconnect, then `P restore --udid U` | A *new* Controller, created from the recovery record and matched by UDID, runs Ghost's real `stopLocation()`. Then check Maps and run `P note --check after-restore --maps …`. |
| 6 | Reboot | After any set: restart the iPhone, then check Maps | `P note --check after-reboot --maps …` |
| 7 | Developer image unmount | After a set (cable in): `P unmount-ddi --udid U`, then check Maps | `P note --check after-unmount --maps …`. Ghost's Prepare re-mounts the image later. |
| 8 | Legacy over usbmux | `P legacy-set --udid U --lat … --lon … --via usbmux` | Repeat checks 1 / 5 / 30 min, and unplug after 1 min. Clear with `P legacy-clear --udid U --via usbmux` *and* with `P restore`. |
| 9 | Legacy over RSD | `P legacy-set … --via rsd` (if `facts` lists a service, add `--service <name>`) | Same as row 8. |

**Check protocol at each checkpoint.** Keep the phone unlocked with Maps open
until the 1-minute check. Lock it between the later checks. At each check,
unlock it, open Apple Maps, tap the location arrow, then run:

```
P note --check 5m --maps spoofed|real|other|unclear --locked yes|no --text "optional detail"
```

`--locked yes` means the phone was locked since the previous check.

Between tests, run `P restore --udid U` and confirm Maps shows your real
position before starting the next test.

### pymobiledevice3 version

Ghost refuses any version other than `11.12.4`. The behaviour being measured
belongs to the device (when iOS ends a simulation), so the host library
version should matter only if a version changes *how* the channel is closed.
To check a newer release, create a second venv, install that version, and
re-run rows 1 and 4 with it. Record the version below. The `facts` line logs a
warning whenever the version is not the pinned one. Do not change Ghost's pin
based on this.

## Results

Device: iPhone17,3 · iOS: 27.0.1 (24A446) · Host: Windows 11 x64 (10.0.26200), Apple Devices app ·
pymobiledevice3: 11.12.4 (pinned) · Date: 2026-11-04 (UTC)

| # | Test | 1 min | 5 min | 30 min | Clear/Restore result |
| --- | --- | --- | --- | --- | --- |
| 1 | DVT loop → kill, cable in | not run | not run | not run | not run |
| 2 | DVT one-shot → kill, cable in | not run | not run | not run | not run |
| 3 | DVT → clean close, cable in | not run | not run | not run | not run |
| 4 | DVT loop → **unplug** | **real** (unlocked, Maps open) | not needed | not needed | Restore sent after reconnect (row 5) |
| 5 | Restore by a new process via record + UDID | — | — | — | **Clear sent** 2026-11-04T02:09:33Z (`cleared:true`, record removed). Maps check pending. |
| 6 | Reboot clears? | — | — | — | not run |
| 7 | DDI unmount clears? | — | — | — | not run |
| 8 | Legacy usbmux (cable in / unplugged) | not run | not run | not run | not run |
| 9 | Legacy RSD (cable in / unplugged) | not run | not run | not run | not run |

### Row 4 details

* 02:05:26Z: `dvt-set --end unplug` started. The first run mounted the
  developer disk image.
* 02:05:32Z: the first set was acknowledged. While still plugged in, the user
  saw Maps at the Statue of Liberty (`while-connected: spoofed`).
* 02:06:25Z: the cable was pulled. The DVT disconnect was detected after 49
  one-second acknowledgements, and no clear was sent.
* 1-minute check: Maps showed the **real location**. The exact moment it
  reverted was not observed. It could have been immediate.

Because the spoof had already reverted within a minute, the 5- and 30-minute
checks could not change the outcome, so they weren't needed.

### Other facts recorded

* Before the developer disk image was mounted, the legacy
  `com.apple.dt.simulatelocation` service returned `InvalidService` over
  usbmux, and RSD advertised no location services. Rows 8 and 9 were not
  attempted. Run `P facts` again now that the image is mounted to check those
  services properly.
* Developer Mode was initially hidden. The AMFI "reveal" call, followed by a
  restart, made the switch appear in Settings.

Raw log (`P report`):

```
2026-11-04T02:05:16.222Z facts        developerMode:true, personalizedImageMounted:false, legacy:InvalidService, rsdLocationServices:[]
2026-11-04T02:05:26.885Z dvt-set:start lat 40.689247 lon -74.044502 end:unplug
2026-11-04T02:05:32.540Z dvt-set:acknowledged refreshCount 1
2026-11-04T02:06:25.446Z dvt-set:disconnect-detected acks 49
2026-11-04T02:07:48.753Z observation  while-connected: spoofed (unlocked)
2026-11-04T02:07:48.903Z observation  1m: real (unlocked, Maps open)
```

## Conclusion (2026-11-04)

On iOS 27.0.1 with pymobiledevice3 11.12.4, a DVT location simulation does
**not** survive losing the USB connection: the phone returned to its real
location within a minute. This matches upstream's CLI design, which holds the
channel open. Ghost's current behaviour is right: loop while connected, and
report "unknown" on disconnect. No "detached / persisting" state was added.
The legacy service path is untested on this phone (see above).

## Decision rule for Phase 2

Phase 2 may start only if **all** of these hold for at least one path:

1. Rows 4 (or 8/9 unplugged) show `spoofed` at 1, 5 **and** 30 minutes, both
   locked and unlocked.
2. Row 5 shows Restore succeeded, and Maps then shows the real location.
3. The result is repeatable: two runs on the same phone and iOS version.

If no path meets these conditions, Ghost keeps its current behaviour: it loops
while connected and reports the state as unknown on disconnect. No
"persisting" state is added, and this document records the negative result.

## Risks to record with any positive result

* Ghost cannot observe the phone while it is unplugged. A positive test shows
  only that the phone *can* keep the spoof, not that it will every time.
* A clear is never acknowledged (`expects_reply=False`, or no reply at all for
  the legacy service). "Restore succeeded" means the command was written; the
  user still has to check Maps.
* A spoof that persists without Ghost may stay until reboot if the recovery
  record is lost or discarded. The automatic cleanup when a different phone
  connects already discards records without sending a clear.
