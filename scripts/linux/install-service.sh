#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs Ghost's headless server as a systemd service for the current user.
# Run from the Ghost folder:  sh scripts/linux/install-service.sh
# It writes /etc/systemd/system/ghost.service (with sudo) and starts it. Remove with:
#   sudo systemctl disable --now ghost && sudo rm /etc/systemd/system/ghost.service
set -eu

ghost_dir=$(cd "$(dirname "$0")/../.." && pwd)
user=$(id -un)
node=$(command -v node || true)
if [ -z "$node" ]; then echo "Node.js was not found. Install it first (see docs/raspberry-pi.md)." >&2; exit 1; fi
if [ ! -x "$ghost_dir/sidecar/.venv/bin/python" ]; then echo "The iPhone helper venv is missing (sidecar/.venv). See docs/raspberry-pi.md." >&2; exit 1; fi
if [ "$user" = root ]; then echo "Run this as your normal user, not root; it uses sudo only to install the service." >&2; exit 1; fi

unit=$(cat <<EOF
[Unit]
Description=Ghost location server (phone control over Tailscale)
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service usbmuxd.service

[Service]
Type=simple
User=$user
WorkingDirectory=$ghost_dir
ExecStart=$node $ghost_dir/server/main.mjs
Restart=on-failure
RestartSec=10
# Only Ghost gets the stop signal, so it can still use its iPhone helper to send Restore.
# Anything left after the timeout is killed.
KillMode=mixed
TimeoutStopSec=90
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
)

echo "Installing /etc/systemd/system/ghost.service for user $user, folder $ghost_dir:"
echo "$unit"
printf '%s\n' "$unit" | sudo tee /etc/systemd/system/ghost.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ghost
echo
echo "Ghost is running. Logs: journalctl -u ghost -f"
echo "Pairing code for the phone page: node server/main.mjs pair"
