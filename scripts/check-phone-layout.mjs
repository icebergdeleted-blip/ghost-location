// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the phone control page at phone sizes: Set and Restore must stay on screen
// in portrait and landscape, with long place names, before and after setting a location.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PhoneControl } from '../backend/phone-control.mjs';

const LONG = 'Statue of Liberty National Monument, Liberty Island, Manhattan, New York County, New York, 10004, United States';
const phone = { id: 'ios:TEST', name: 'Alex’s iPhone 16 Pro Max', state: 'ready', connection: 'remote' };
const state = { busy: false, route: null, session: null, devices: [phone],
  savedPlaces: ['Home', 'Work', 'Grandma’s house', 'Gym', 'Airport'].map((label, i) => ({ id: String(i), label, latitude: 40 + i, longitude: -74 })) };
const controller = {
  snapshot: () => structuredClone(state),
  applyLocation: async input => { state.session = { ...input, status: 'active', deviceName: phone.name, connection: 'remote', lastRefreshAt: Date.now() }; },
  stopLocation: async () => { state.session = null; },
};
const dir = await mkdtemp(path.join(os.tmpdir(), 'ghost-layout-'));
const control = new PhoneControl({ controller, dataPath: path.join(dir, 'p.json'), port: 0, address: () => '127.0.0.1', allowAddress: () => true,
  search: async () => [{ label: LONG, latitude: 40.689247, longitude: -74.044502 }] });
await control.start();
const base = `http://127.0.0.1:${control.port}`;
const browser = await chromium.launch(process.env.GHOST_BROWSER_CHANNEL ? { channel: process.env.GHOST_BROWSER_CHANNEL } : {});
const failures = [];
const shots = process.argv[2];
try {
  for (const [name, viewport] of [['portrait', { width: 375, height: 667 }], ['landscape', { width: 667, height: 375 }], ['large', { width: 430, height: 932 }]]) {
    state.session = null;
    const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 204 }));
    await page.goto(`${base}/#pair=${control.newPairingCode().pairing.code}`);
    await page.waitForSelector('#control-view:not([hidden])');
    await page.fill('#search', 'liberty');
    await page.press('#search', 'Enter');
    await page.click('#results button');
    await page.waitForTimeout(1100);
    await page.click('#set');
    await page.waitForFunction(() => document.querySelector('#pill').textContent === 'Spoofing');
    await page.waitForFunction(() => !document.querySelector('#restore').disabled);
    for (const id of ['set', 'restore', 'apple-maps']) {
      const box = await page.locator(`#${id}`).boundingBox();
      const onScreen = box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;
      if (!onScreen) failures.push(`${name}: #${id} off screen ${JSON.stringify(box)}`);
    }
    const scrollW = await page.evaluate(() => Math.max(document.querySelector('#sheet').scrollWidth - document.querySelector('#sheet').clientWidth, document.documentElement.scrollWidth - innerWidth));
    if (scrollW > 0) failures.push(`${name}: sideways overflow ${scrollW}px`);
    if (shots) await page.screenshot({ path: path.join(shots, `phone-${name}.png`) });
    await page.waitForTimeout(1100); // phone commands are limited to one per second
    await page.click('#restore');
    await page.waitForFunction(() => document.querySelector('#pill').textContent === 'Real location');
    await page.close();
  }
} finally {
  await browser.close(); await control.stop(); await rm(dir, { recursive: true, force: true });
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('phone layout ok: Set, Restore and Apple Maps stay on screen in portrait, landscape and large phones');
