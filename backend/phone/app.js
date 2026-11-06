// SPDX-License-Identifier: GPL-3.0-or-later
// Phone control page. Talks only to the Ghost computer that served it (same origin).
(() => {
  const $ = id => document.getElementById(id);
  let state = null, map = null, pin = null, spoof = null, chosen = null, sending = false, timer = null, searchNumber = 0;

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
  }

  function showControl() {
    $('pair-view').hidden = true; $('control-view').hidden = false;
    if (!timer) timer = setInterval(refresh, 3000);
    if (map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView([39.5, -98.35], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    map.on('click', event => choose({ latitude: event.latlng.lat, longitude: event.latlng.lng, label: 'Dropped pin' }, false));
    const session = state?.session;
    if (session && Number.isFinite(session.latitude)) map.setView([session.latitude, session.longitude], 14);
  }

  const fixed = value => Number(value).toFixed(5);
  function choose(place, center = true) {
    chosen = { latitude: Number(Number(place.latitude).toFixed(6)), longitude: Number(Number(place.longitude).toFixed(6)), label: place.label || 'Dropped pin' };
    if (pin) pin.setLatLng([chosen.latitude, chosen.longitude]);
    else pin = L.circleMarker([chosen.latitude, chosen.longitude], { radius: 10, color: '#fff', weight: 3, fillColor: '#087bff', fillOpacity: 1 }).addTo(map);
    if (center) map.setView([chosen.latitude, chosen.longitude], Math.max(map.getZoom(), 15));
    $('chosen').hidden = false; $('hint').hidden = true;
    $('chosen-label').textContent = chosen.label;
    $('chosen-coords').textContent = `${fixed(chosen.latitude)}, ${fixed(chosen.longitude)}`;
    $('apple-maps').href = `https://maps.apple.com/?ll=${chosen.latitude},${chosen.longitude}&q=${encodeURIComponent(chosen.label)}`;
    $('results').hidden = true;
    render();
  }

  function render() {
    if (!state) return;
    const session = state.session, live = session?.status === 'active';
    $('pill').textContent = !session ? 'Real location' : live ? 'Spoofing' : session.status === 'stopping' ? 'Restoring…' : session.status === 'applying' || session.status === 'reconnecting' ? 'Connecting…' : 'Needs attention';
    $('pill').className = `pill ${live ? 'live' : session ? 'warn' : ''}`;
    const phoneName = session?.deviceName || state.devices[0]?.name || 'Phone';
    const when = session?.lastRefreshAt ? new Date(session.lastRefreshAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
    $('status-text').textContent = session
      ? `${session.label || 'Custom location'} · ${phoneName}${live && when ? ` · ${when}` : ''}`
      : state.devices.length ? `${phoneName} ready` : 'No phone connected to Ghost';
    if (session && !live && session.message) $('status-text').textContent = session.message;
    $('set').textContent = session ? 'Update location' : 'Set location';
    $('set').disabled = sending || state.busy || !chosen || (!session && !state.devices.length) || Boolean(state.route);
    $('restore').disabled = sending || state.busy || !session;
    $('locate').disabled = !session;
    if (session && Number.isFinite(session.latitude) && map) {
      const at = [session.latitude, session.longitude];
      if (spoof) spoof.setLatLng(at);
      else spoof = L.circleMarker(at, { radius: 8, color: '#fff', weight: 3, fillColor: '#1f9d55', fillOpacity: 1 }).addTo(map).bindTooltip('Phone is here');
    } else if (spoof) { spoof.remove(); spoof = null; }
    const chips = $('saved');
    const names = state.savedPlaces.map(item => item.label).join('\n');
    if (chips.dataset.names !== names) {
      chips.dataset.names = names;
      chips.replaceChildren(...state.savedPlaces.map(item => {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.textContent = `★ ${item.label}`;
        chip.onclick = () => choose(item);
        return chip;
      }));
    }
  }

  function say(text, error = false) { $('message').textContent = text; $('message').className = `message ${error ? 'error' : ''}`; }

  async function refresh() {
    try { state = await api('/api/state'); showControl(); render(); }
    catch (error) { if (!$('pair-view').hidden) return; say('Can’t reach Ghost on your computer. Check Tailscale and that the computer is awake.', true); $('pill').textContent = 'Offline'; $('pill').className = 'pill warn'; }
  }

  async function command(path, body, done) {
    sending = true; render(); say('Sending…');
    try { state = await api(path, body); say(done); }
    catch (error) { say(error.message, true); }
    finally { sending = false; render(); }
  }

  async function pair(code) {
    $('pair-error').textContent = '';
    try { await api('/api/pair', { code }); $('pair-code').value = ''; await refresh(); }
    catch (error) { $('pair-error').textContent = error.message; }
  }

  $('pair-form').addEventListener('submit', event => { event.preventDefault(); pair($('pair-code').value.trim()); });

  $('search-form').addEventListener('submit', async event => {
    event.preventDefault();
    const query = $('search').value.trim();
    $('search').blur();
    const coords = query.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (coords) {
      const [lat, lon] = [Number(coords[1]), Number(coords[2])];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) choose({ latitude: lat, longitude: lon, label: 'Coordinates' });
      return;
    }
    if (query.length < 2) return;
    const results = $('results'), request = ++searchNumber;
    results.hidden = false;
    results.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Searching…' }));
    try {
      const places = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (request !== searchNumber) return;
      if (!places.length) { results.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'No places found.' })); return; }
      results.replaceChildren(...places.map(place => {
        const row = document.createElement('button');
        row.type = 'button';
        const title = document.createElement('span'); title.textContent = place.label;
        const sub = document.createElement('small'); sub.textContent = `${fixed(place.latitude)}, ${fixed(place.longitude)}`;
        row.append(title, sub);
        row.onclick = () => { choose(place); $('search').value = place.label; };
        return row;
      }));
    } catch (error) {
      if (request === searchNumber) results.replaceChildren(Object.assign(document.createElement('p'), { textContent: error.message }));
    }
  });
  $('search').addEventListener('input', () => { if (!$('search').value) $('results').hidden = true; });

  $('locate').addEventListener('click', () => { const s = state?.session; if (s) map.setView([s.latitude, s.longitude], Math.max(map.getZoom(), 15)); });
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());
  $('coords-form').addEventListener('submit', event => {
    event.preventDefault();
    const lat = Number($('lat').value), lon = Number($('lon').value);
    if ($('lat').value && $('lon').value && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) choose({ latitude: lat, longitude: lon, label: 'Coordinates' });
    else say('Use a latitude from −90 to 90 and longitude from −180 to 180.', true);
  });
  $('set').addEventListener('click', () => chosen && command('/api/set', chosen, 'Location set. Open Apple Maps to check.'));
  $('restore').addEventListener('click', () => command('/api/restore', {}, 'Restored. Apps may take a moment to update.'));

  // A scanned QR code carries the pairing code in the URL fragment (never sent to the server).
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragment && /^\d{6}$/.test(fragment)) {
    history.replaceState(null, '', location.pathname);
    $('pair-view').hidden = false;
    pair(fragment);
  } else refresh();
})();
