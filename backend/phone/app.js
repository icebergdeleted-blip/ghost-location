// SPDX-License-Identifier: GPL-3.0-or-later
// Phone control page. Talks only to the Ghost computer that served it (same origin).
(() => {
  const $ = id => document.getElementById(id);
  let state = null, map = null, pin = null, chosen = null, sending = false, timer = null;

  async function api(path, body) {
    const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { showPair(); throw new Error(data.error || 'Pair this phone first.'); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function showPair() {
    clearInterval(timer); timer = null;
    $('control-view').hidden = true; $('pair-view').hidden = false;
    $('pill').textContent = 'Not paired'; $('pill').className = 'pill';
  }

  function showControl() {
    $('pair-view').hidden = true; $('control-view').hidden = false;
    if (!map) {
      map = L.map('map', { zoomControl: true, attributionControl: true }).setView([41.8827, -87.6233], 12);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
      map.on('click', event => choose(event.latlng.lat, event.latlng.lng, false));
    }
    setTimeout(() => map.invalidateSize(), 50);
    if (!timer) timer = setInterval(refresh, 3000);
  }

  function choose(lat, lon, center = true) {
    chosen = { latitude: Number(lat.toFixed(6)), longitude: Number(lon.toFixed(6)) };
    $('lat').value = chosen.latitude; $('lon').value = chosen.longitude;
    if (pin) pin.setLatLng([lat, lon]);
    else pin = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#087bff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView([lat, lon], Math.max(map.getZoom(), 14));
    render();
  }

  function render() {
    if (!state) return;
    const session = state.session;
    const live = session?.status === 'active';
    const pill = $('pill');
    pill.textContent = !session ? 'Real location' : live ? 'Spoofing' : session.status === 'stopping' ? 'Restoring…' : 'Needs attention';
    pill.className = `pill ${live ? 'live' : session ? 'warn' : ''}`;
    const status = $('status');
    status.replaceChildren();
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    if (session) {
      title.textContent = `${session.label || 'Custom location'}`;
      const when = session.lastRefreshAt ? new Date(session.lastRefreshAt) : null;
      detail.textContent = `${session.deviceName || 'Phone'} · ${session.status}${live && when ? ` · confirmed ${when.toLocaleTimeString()}` : ''}${session.message && !live ? ` · ${session.message}` : ''}`;
    } else {
      title.textContent = state.devices.length ? 'No location set' : 'No phone connected to Ghost';
      detail.textContent = state.devices.length ? `Ready: ${state.devices.map(device => device.name).join(', ')}` : 'Connect the phone to Ghost on the computer first.';
    }
    status.append(title, detail);
    $('set').textContent = session ? 'Update location' : 'Set location';
    $('set').disabled = sending || state.busy || !chosen || (!session && !state.devices.length) || Boolean(state.route);
    $('restore').disabled = sending || state.busy || !session;
    const saved = $('saved');
    if (saved.options.length !== state.savedPlaces.length + 1) {
      saved.replaceChildren(new Option('Saved places…', ''));
      state.savedPlaces.forEach((item, index) => saved.add(new Option(item.label, String(index))));
    }
  }

  async function refresh() {
    try { state = await api('/api/state'); showControl(); render(); $('error').textContent = ''; }
    catch (error) { if (!$('pair-view').hidden) return; $('error').textContent = error.message; $('pill').textContent = 'Offline'; $('pill').className = 'pill warn'; }
  }

  async function command(path, body, done) {
    sending = true; render(); $('error').textContent = '';
    try { state = await api(path, body); $('error').textContent = done; }
    catch (error) { $('error').textContent = error.message; }
    finally { sending = false; render(); }
  }

  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('pair-error').textContent = '';
    try { await api('/api/pair', { code: $('pair-code').value.trim() }); $('pair-code').value = ''; await refresh(); }
    catch (error) { $('pair-error').textContent = error.message; }
  });
  for (const id of ['lat', 'lon']) $(id).addEventListener('change', () => {
    const lat = Number($('lat').value), lon = Number($('lon').value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && $('lat').value && $('lon').value) choose(lat, lon);
  });
  $('saved').addEventListener('change', () => {
    const item = state?.savedPlaces[Number($('saved').value)];
    if (item) { choose(item.latitude, item.longitude); chosen.label = item.label; }
  });
  $('set').addEventListener('click', () => chosen && command('/api/set', chosen, 'Location sent. Check your map app.'));
  $('restore').addEventListener('click', () => command('/api/restore', {}, 'Restore sent. Apps may take a moment to update.'));
  refresh();
})();
