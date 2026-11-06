# Phone control (over Tailscale)

Set or restore locations from your phone's browser while Ghost runs on a computer somewhere
else, for example at home. It's off by default.

## Set it up

1. Install Tailscale on the computer and on your phone, signed in to the same account.
2. In Ghost, open **Settings › Phone control** and turn on **Control Ghost from your phone**.
   If Windows asks whether Ghost may use the network, allow it on private networks.
3. In Ghost, choose **Pair a phone** and scan the QR code with the iPhone camera. The page opens
   and pairs in one step. You can also open the address shown (your computer's Tailscale name,
   for example `http://laptop.tailnet.ts.net:7420`, or its `100.x` IP) and type the 6-digit
   code. A code works once and expires after 5 minutes. The phone stays signed in for 30 days.
4. Optional: in Safari, choose Share › **Add to Home Screen** so Ghost opens like an app.

The phone page is a full-screen map. You can search at the top (through Ghost's search provider),
tap the map, or tap a saved-place chip. Then choose **Set location** or **Restore**. These use the
same Set and Restore actions as the desktop app. **Open in Apple Maps** shows the chosen spot in
the Apple Maps app. ◎ jumps to where the phone currently appears. The phone being controlled must
still be connected to Ghost (USB, Wi-Fi, or Remote).

### Apple Maps as the map?

Apple's web map (MapKit JS) needs a paid Apple Developer account, a signed token, and a
registered HTTPS website, so this private page uses OpenStreetMap. Use **Open in Apple Maps** to
check a spot in Apple's own app.

### A cleaner HTTPS address (optional)

Tailscale can put an HTTPS address in front of Ghost, without the `:7420`, using
`tailscale serve`. This changes your Tailscale setup, so Ghost doesn't do it for you. See
Tailscale's documentation for `tailscale serve`. If you use it, the address it gives must be
added to Ghost's allowed names first. That isn't supported yet.

## Safety model

| Protection | How |
| --- | --- |
| Tailscale only | The page listens only on this computer's Tailscale address (`100.64.0.0/10`), never on Wi-Fi/LAN interfaces or the internet. Requests from other addresses are refused. |
| Encrypted transport | Tailscale encrypts the connection (WireGuard), so the page itself uses plain HTTP. |
| Pairing | A 6-digit code from the computer, valid for 5 minutes. Five wrong tries cancel it. |
| Sessions | A random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie. Only SHA-256 hashes are saved (`phone-control.json` in Ghost's data folder). At most 10 phones. |
| Browser attacks | The `Host` header must be this computer's Tailscale address (blocks DNS rebinding). A POST must come from the same origin. A strict Content-Security-Policy applies, the page can't be framed, and request bodies are JSON only, up to 4 KB. |
| Limits | One command per second. The phone sees only what it needs: status, ready phones, and saved places. |
| Revoke | **Sign out all phones** removes every session at once. Turning phone control off stops the server. |

Anyone on your tailnet can open the page, but nobody can use it without a pairing code from the
computer. Share your tailnet only with people you trust.

## Limits

- If the computer sleeps, quits, or loses Tailscale, the phone page can't reach it.
- The phone being spoofed must stay connected to Ghost. Over Remote, the phone returns to its
  real location within about a minute if that connection drops. Ghost shows a desktop alert
  and keeps retrying.
