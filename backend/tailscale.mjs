// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { run } from './process.mjs';

/** Tailscale's CLI locations; read-only use (`status --json`) only. */
export function tailscaleCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
    return [...new Set(roots.map(root => path.win32.join(root, 'Tailscale', 'tailscale.exe')))];
  }
  if (platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
}

const inTailnetRange = ip => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10, Tailscale's address range
};
const cleanName = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Apple device';

/** iPhones and iPads in `tailscale status --json`, online first. Output is untrusted text: validate everything. */
export function parseApplePeers(json) {
  let data;
  try { data = JSON.parse(json); } catch { throw new Error('Tailscale returned an unreadable status.'); }
  if (data?.BackendState && data.BackendState !== 'Running') throw new Error('Tailscale is not connected on this computer. Open Tailscale and sign in.');
  const peers = Object.values(data?.Peer && typeof data.Peer === 'object' ? data.Peer : {});
  return peers
    .filter(peer => /^ios$/i.test(String(peer?.OS || '')))
    .map(peer => {
      const ip = (Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []).find(value => isIP(value) === 4 && inTailnetRange(value));
      return ip ? { name: cleanName(peer.HostName), ip, online: peer.Online === true } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .slice(0, 20);
}

export async function findTailscaleApplePeers({ runner = run, platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const executable = tailscaleCandidates(platform, env).find(candidate => exists(candidate));
  if (!executable) throw new Error('Tailscale is not installed on this computer. Install it, sign in, then try again, or type the address.');
  let result;
  try { result = await runner(executable, ['status', '--json'], { timeoutMs: 8000, maxOutputBytes: 4 * 1024 * 1024 }); }
  catch { throw new Error('Tailscale did not respond. Make sure it is running, or type the address.'); }
  if (result.code !== 0) throw new Error('Tailscale is not running on this computer. Open it and sign in, or type the address.');
  return parseApplePeers(result.stdout);
}
