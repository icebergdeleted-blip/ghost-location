import test from 'node:test';
import assert from 'node:assert/strict';
import {wifiStatus, linuxWirelessNames} from '../backend/network.mjs';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const ip = address => ({address, internal: false});
test('Mac Wi-Fi requires an address on the Wi-Fi interface, not Ethernet or a self-assigned address', async () => {
  const runner = async () => ({code: 0, stdout: 'Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\n'});
  for (const [interfaces, expected] of [[{en0: [ip('192.168.1.2')]}, false], [{en1: [ip('169.254.1.2')]}, false], [{en1: [ip('192.168.1.2')]}, true]]) {
    assert.deepEqual(await wifiStatus({platform: 'darwin', runner, interfaces: () => interfaces}), {wifi: expected});
  }
});
test('Windows handles single and multiple active wireless adapters', async () => {
  for (const stdout of ['"Wi-Fi"', '["Wi-Fi", "Wireless 2"]', '\uFEFF"Wi-Fi"']) {
    const result = await wifiStatus({platform: 'win32', runner: async () => ({code: 0, stdout}), interfaces: () => ({'Wi-Fi': [ip('10.0.0.2')]})});
    assert.deepEqual(result, {wifi: true});
  }
  assert.deepEqual(await wifiStatus({platform: 'win32', runner: async () => ({code: 0, stdout: ''})}), {wifi: false});
});
test('Linux (e.g. Raspberry Pi) finds Wi-Fi through sysfs and still needs a usable address', async () => {
  const wireless = async () => ['wlan0'];
  assert.deepEqual(await wifiStatus({platform: 'linux', wireless, interfaces: () => ({eth0: [ip('192.168.1.5')], wlan0: [ip('192.168.1.21')]})}), {wifi: true});
  assert.deepEqual(await wifiStatus({platform: 'linux', wireless, interfaces: () => ({eth0: [ip('192.168.1.5')]})}), {wifi: false});
  assert.deepEqual(await wifiStatus({platform: 'linux', wireless: async () => [], interfaces: () => ({eth0: [ip('192.168.1.5')]})}), {wifi: false});
  const root = mkdtempSync(path.join(tmpdir(), 'ghost-sysfs-'));
  try {
    mkdirSync(path.join(root, 'wlan0', 'wireless'), {recursive: true});
    mkdirSync(path.join(root, 'eth0'));
    mkdirSync(path.join(root, 'tailscale0'));
    assert.deepEqual(await linuxWirelessNames(root), ['wlan0']);
    assert.deepEqual(await linuxWirelessNames(path.join(root, 'missing')), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
