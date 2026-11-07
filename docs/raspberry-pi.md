# Ghost on a Raspberry Pi (headless server)

Run Ghost on an always-on Linux computer, such as a Raspberry Pi 5, and control it from your
phone's browser over Tailscale. There is no desktop window: you set up the iPhone with a few
commands over SSH, and the [phone page](phone-control.md) does Set and Restore.

Tested target: Raspberry Pi 5, Raspberry Pi OS / Debian 13 (trixie), arm64. Needs Tailscale on the
Pi, signed in to the same tailnet as your phone.

## 1. Install the system packages

```sh
sudo apt update
sudo apt install -y usbmuxd python3-venv python3-dev libssl-dev libffi-dev xz-utils curl git
sudo apt install -y adb   # only needed for Android phones
```

`usbmuxd` talks to an iPhone over USB. It is needed for the one-time setup and for **Prepare**
after each iPhone restart.

## 2. Install Node.js 24

Debian's Node.js is older than Ghost needs. This installs the official arm64 build into
`/usr/local`, after checking its checksum:

```sh
cd /tmp
V=v24.18.0
curl -fLO https://nodejs.org/dist/$V/node-$V-linux-arm64.tar.xz
curl -fLO https://nodejs.org/dist/$V/SHASUMS256.txt
grep " node-$V-linux-arm64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf node-$V-linux-arm64.tar.xz -C /usr/local --strip-components=1 \
  --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
node -v
```

## 3. Get Ghost

```sh
git clone https://github.com/icebergdeleted-blip/ghost-location.git ~/ghost-location
cd ~/ghost-location
npm ci --omit=dev
python3 -m venv sidecar/.venv
sidecar/.venv/bin/pip install -r sidecar/requirements.txt
```

`--omit=dev` skips Electron and the build tools; the server doesn't use them. The iPhone helper
runs straight from `sidecar/.venv`.

## 4. Try it in the foreground

```sh
npm run server
```

It prints the phone page address, for example `http://alexrpi.tailnet.ts.net:7420`. If Tailscale
isn't connected yet, it says so and retries every 15 seconds. Leave it running and open a second
SSH session for the next steps. Stop it with Ctrl+C.

## 5. Set up the iPhone (once, with a USB cable)

Turn on Developer Mode on the iPhone first (Settings › Privacy & Security › Developer Mode).
Plug the iPhone into the Pi, unlock it, and run these in the Ghost folder:

```sh
node server/main.mjs devices          # the iPhone should be listed; tap Trust on the phone if asked
node server/main.mjs prepare          # mounts the developer image (needs internet the first time)
node server/main.mjs setup-remote     # one-time remote access pairing
node server/main.mjs find-iphones     # the iPhone's Tailscale address
node server/main.mjs remote-address 100.x.y.z
```

Unplug the iPhone, keep it on Wi-Fi with Tailscale on, then:

```sh
node server/main.mjs connection remote
node server/main.mjs devices          # the iPhone should be listed over Remote
```

When more than one phone is connected, add the id that `devices` shows, for example
`node server/main.mjs prepare ios:00008140-…`. Run `node server/main.mjs help` for every command.

## 6. Pair your phone's browser

```sh
node server/main.mjs pair
```

Open the link it prints on your phone (or open the address and type the 6-digit code). The code
works once and expires after 5 minutes. Then search or tap the map and choose **Set location**.

## 7. Start Ghost automatically

Stop the foreground server (Ctrl+C), then:

```sh
sh scripts/linux/install-service.sh
journalctl -u ghost -f      # logs, including connection-lost alerts
```

The script shows the service file before installing it. `systemctl stop ghost` (and shutting the Pi
down) first tries to Restore the iPhone's real location, like quitting the desktop app. If that
fails, the session stays recorded so you can Restore later.

To remove the service: `sudo systemctl disable --now ghost && sudo rm /etc/systemd/system/ghost.service`.

## Updating

```sh
cd ~/ghost-location
git pull
npm ci --omit=dev
sidecar/.venv/bin/pip install -r sidecar/requirements.txt
sudo systemctl restart ghost
```

## Limits

Same as on a desktop (see [wifi-remote-findings.md](wifi-remote-findings.md)):

- The iPhone must be joined to a Wi-Fi network. Cellular alone is refused by iOS; a second
  phone's personal hotspot works.
- The location lasts only while connected. If the connection drops, the iPhone returns to its real
  location within about a minute.
- After each iPhone restart, plug it into the Pi and run `node server/main.mjs prepare`.
- `restore` (`node server/main.mjs restore`) and the phone page's **Restore** both work at any
  time while the iPhone is reachable.

Admin commands go through `~/.local/share/ghost/control.sock`, which only your Pi user can open.
Nothing besides the phone page listens on the network, and the phone page listens only on the
Pi's Tailscale address.
