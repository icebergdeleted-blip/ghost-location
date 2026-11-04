export function coordinates(value) {
  if (!value || typeof value !== 'object') throw new Error('Choose a location first.');
  const { latitude, longitude } = value;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Use a latitude from −90 to 90 and longitude from −180 to 180.');
  }
  return { latitude, longitude };
}

export function text(value, fallback = '', max = 240) {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || fallback;
}

export function place(value) {
  const point = coordinates(value);
  return { ...point, label: text(value.label, `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`) };
}

// Plain HTTP is accepted only for services on this computer or a private LAN
// (e.g. a self-hosted Photon or OSRM for offline use). Public endpoints need HTTPS.
export function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function serviceUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Use a valid ${label} URL.`); }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw new Error(`Use an HTTPS ${label} URL (HTTP only for this computer or a private network), without credentials or query parameters.`);
  }
  return url;
}

export function geocoderUrl(value) {
  return serviceUrl(value, 'Photon API').href;
}

export const DEFAULT_ROUTING_URL = 'https://router.project-osrm.org/';
export function routingUrl(value) {
  const url = serviceUrl(value, 'OSRM routing');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export const DEFAULT_SPEED_MPH = 45;
export const MIN_SPEED_MPH = 1;
export const MAX_SPEED_MPH = 120;
export const MPH_TO_MPS = 0.44704; // exact: 1609.344 m / 3600 s
export function speedMph(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SPEED_MPH || value > MAX_SPEED_MPH) {
    throw new Error(`Choose a route speed from ${MIN_SPEED_MPH} to ${MAX_SPEED_MPH} mph.`);
  }
  return Math.round(value * 10) / 10;
}
