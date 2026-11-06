# iPhone Wi-Fi and remote (Tailscale) findings

Hardware: iPhone17,3 on iOS 27.0.1, Windows 11 host. Tested 2026-11-05 and 2026-11-06.
The network probes and Wi-Fi fixes below used pymobiledevice3 11.12.4. The RemotePairing results
used 11.50.0, which Ghost now pins.
All probes were read-only unless a row says a location was set. Each set was followed by a clear.

## Network paths, compared at the same moment

| Probe | Local Wi-Fi (laptop hotspot) | Tailscale (`100.x`) | Campus Wi-Fi, other subnet |
| --- | --- | --- | --- |
| Bonjour `_apple-mobdev2._tcp` | phone found | does not cross | not found |
| Lockdown `QueryType` (TCP 62078) | **reply** | connection reset / hang-up | hang-up |
| RemotePairing handshake (TCP 49152), no record | reset | reset | — |

Over Tailscale, the iPhone refuses connections that it accepts on local Wi-Fi. This was confirmed
from the laptop and separately from a Raspberry Pi on another network. We could not tell whether
iOS treats Tailscale's inbound connections as loopback or rejects the VPN interface; that would
need code running on the phone.

## Ghost Wi-Fi mode on iOS 27: what this branch fixes

1. **Private Wi-Fi Address.** Upstream `get_mobdev2_lockdowns(only_paired=True)` matches the
   Bonjour MAC against the pair record's hardware MAC. That silently skips every iPhone using a
   per-network private address, which is the iOS default. `wifi_lockdowns()` instead identifies
   a phone by a pair record it accepts plus the UDID it reports.
2. **Back-to-back Bonjour.** A second browse within about a second can return nothing. The address
   where each phone last proved its identity is tried first, and identity is re-verified each
   time. An empty browse is retried once with a longer window.
3. **Image mounter over Wi-Fi.** The phone starts `mobile_image_mounter` over Wi-Fi but closes the
   connection on the first request. Over Wi-Fi, Prepare now skips the image check. The image
   from the last USB Prepare stays mounted until the phone restarts.

Verified on hardware: discovery found the phone 6 out of 6 times, in about 2.5 s each.

## Resolved: RemotePairing (2026-11-05)

pymobiledevice3 11.12.4's SRP code produced a pairing proof that iOS 27.0.1 rejects. With 11.50.0,
`lockdown remotepairing --pair` over USB created the RemotePairing record without any prompt.
Ghost's Wi-Fi and remote connections now tunnel through RemotePairing:

| Hardware result (iPhone17,3, iOS 27.0.1) | Outcome |
| --- | --- |
| Hotspot Wi-Fi, Bonjour `_remotepairing._tcp` | tunnel in 1.0 s; 7/7 location acks; clear sent |
| Tailscale 100.x, phone on the same hotspot | tunnel in 1.5 s; 7/7 acks; clear sent |
| Tailscale 100.x, phone on campus Wi-Fi, relayed (DERP), unplugged | tunnel in 3.6 s; 7/7 acks (about 0.6 s RTT); clear sent |
| Tailscale, phone on cellular only (Wi-Fi off) | ports 49152 and 62078 refused; iOS switches the services off |
| Tailscale, phone joined to another phone's personal hotspot (that phone on mobile data) | Ghost connected in Remote mode; Set moved the iPhone and Restore returned it (user-tested 2026-11-06) |
| Ghost Controller in remote mode (`scripts/remote-e2e-check.mjs`) | found on the first scan; active in 1.5 s; 8 refresh acks in 8 s; Restore cleared the session |

Limits: the iPhone must be joined to some Wi-Fi network (any network; it doesn't have to match
the computer's). Away from Wi-Fi, a personal hotspot from a second phone on mobile data works. The developer image needs one USB Prepare after each iPhone restart. The spoof
lasts only while the tunnel is up.

## Earlier blocker (superseded)

`CoreDeviceProxy` over a Wi-Fi lockdown connection starts, but the phone closes the connection at
`request_tunnel_establish`. Ghost 0.1.6's Wi-Fi design (lockdown, then CoreDeviceProxy, then RSD)
therefore cannot create the developer tunnel on iOS 27. Over USB it works.

The candidate route is RemotePairing. iOS 27 lets the phone start the pairing itself
(`pymobiledevice3 remote pair-host`, then Settings → Developer → Paired Macs on the phone), and the
tunnel is then built over Wi-Fi with RemotePairing. This is also the service a third-party
write-up reports reaching over a tailnet through a relay:
https://dev.to/kvnpt/how-to-remotely-iterate-deploy-your-sideloaded-ios-apps-over-tailnet-jak

## Remote USB host (usbmux over an SSH tunnel)

`USBMUXD_SOCKET_ADDRESS=host:port` redirects all of the sidecar's usbmux traffic. A relay to the
local Apple usbmuxd passed discovery over the Tailscale address. Set, refresh, clear and the 15.8
MB developer image mount all passed through a loopback-only relay. Never expose usbmuxd as an open
port; use `ssh -L 127.0.0.1:PORT:/var/run/usbmuxd host`. See `scripts/remote-usbmux-experiment.mjs`.
