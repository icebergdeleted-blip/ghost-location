# iPhone Wi-Fi and remote (Tailscale) findings

Hardware: iPhone17,3 on iOS 27.0.1, Windows 11 host, pymobiledevice3 11.12.4. Tested 2026-11-05.
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

## Still blocked

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
