// map.js — Ubicar direcciones y ordenar la ruta.
// Solo se usa cuando el usuario toca "Armar ruta": entonces las direcciones (calle, número y barrio;
// nunca nombres, teléfonos ni cédulas) se envían a OpenStreetMap: Nominatim (buscar) y OSRM (ruta).
import * as DB from './db.js';
import { geoQueries, normalize, optimizeOrder, orderByCost, distanceM } from './logic.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/';

let leafletP = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = `${LEAFLET}/leaflet.min.css`; css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${LEAFLET}/leaflet.min.js`; s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.L);
    s.onerror = () => { leafletP = null; reject(new Error('No se pudo cargar el mapa. Revisá la conexión.')); };
    document.head.appendChild(s);
  });
  return leafletP;
}

/* ---------------- Búsqueda de direcciones (Nominatim) ---------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function nominatim(params) {
  // Política de uso de Nominatim: como máximo 1 consulta por segundo.
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const u = new URL(NOMINATIM);
  for (const [k, v] of Object.entries({ format: 'jsonv2', limit: '1', countrycodes: 'uy', 'accept-language': 'es', ...params })) u.searchParams.set(k, v);
  // El sitio usa no-referrer; acá se manda solo el origen para que Nominatim identifique la app.
  const r = await fetch(u, { referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!r.ok) throw new Error(`El buscador de direcciones respondió ${r.status}`);
  const j = await r.json();
  return j[0] || null;
}

async function cacheGet() { return (await DB.getMeta('geocache', {})) || {}; }

/** Borra del caché las búsquedas más viejas que la retención de jornadas. */
export async function purgeGeoCache(days) {
  const c = await cacheGet(); const limit = Date.now() - days * 86400000;
  let n = 0;
  for (const k of Object.keys(c)) if (!c[k].at || c[k].at < limit) { delete c[k]; n++; }
  if (n) await DB.setMeta('geocache', c);
}

/** Zona de búsqueda: el rectángulo de la ciudad con ~25 km de margen (para no caer en otra ciudad con la misma calle). */
async function cityBox(city, cache) {
  const key = 'box:' + normalize(city);
  if (!cache[key]) {
    const res = await nominatim({ q: `${city}, Uruguay` });
    cache[key] = { at: Date.now(), r: res?.boundingbox ? res.boundingbox.map(Number) : null };
    await DB.setMeta('geocache', cache);
  }
  const b = cache[key].r; // [sur, norte, oeste, este]
  if (!b) return null;
  const m = 0.25;
  return { viewbox: `${b[2] - m},${b[1] + m},${b[3] + m},${b[0] - m}`, bounded: '1' };
}

async function cachedSearch(q, cache) {
  const key = normalize(JSON.stringify(q));
  if (!cache[key]) {
    const res = await nominatim(q);
    cache[key] = { at: Date.now(), r: res ? { lat: Number(res.lat), lng: Number(res.lon), kind: res.addresstype || res.type || '' } : null };
    await DB.setMeta('geocache', cache);
  }
  return cache[key].r;
}

const ZONE_RADIUS = 4000; // m: un resultado más lejos que esto del barrio de la lista es otra calle con el mismo nombre

/** Busca una dirección. Devuelve { lat, lng, exact } o null. */
export async function geocode(item, city) {
  const cache = await cacheGet();
  const box = await cityBox(city, cache);
  const zoneC = item.zone ? await cachedSearch({ q: `${item.zone}, ${city}`, ...(box || {}) }, cache) : null;
  for (const { q, exact } of geoQueries(item, city)) {
    const r = await cachedSearch({ ...q, ...(box || {}) }, cache);
    if (!r) continue;
    if (zoneC && distanceM(zoneC, r) > ZONE_RADIUS) continue;
    // Si se buscó con número pero solo se encontró la calle/barrio, es aproximada.
    const exactHit = exact && !/^(road|street|suburb|neighbourhood|quarter|city|town|village|residential)$/.test(r.kind);
    return { lat: r.lat, lng: r.lng, exact: exactHit };
  }
  // Nada coincide con el barrio: al menos queda en el barrio (aproximada)
  if (zoneC) return { lat: zoneC.lat, lng: zoneC.lng, exact: false };
  return null;
}

/**
 * Ubica en el mapa las paradas que todavía no tienen coordenadas.
 * onProgress(hechas, total). Devuelve { found, approx, missing }.
 */
export async function geocodeItems(items, city, onProgress = () => {}) {
  const todo = items.filter(it => it.lat == null && it.geo !== 'fail');
  let found = 0, approx = 0, missing = 0;
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
    onProgress(i, todo.length, it);
    let g = null;
    try { g = await geocode({ address: it.address, zone: it.zone }, city); }
    catch (e) { if (!navigator.onLine) throw new Error('Sin conexión: no se pueden buscar las direcciones.'); throw e; }
    if (g) { it.lat = g.lat; it.lng = g.lng; it.geo = g.exact ? 'exact' : 'approx'; g.exact ? found++ : approx++; }
    else { it.lat = null; it.lng = null; it.geo = 'fail'; missing++; }
    await DB.putItem(it);
  }
  onProgress(todo.length, todo.length);
  return { found, approx, missing };
}

/* ---------------- Punto de partida ---------------- */

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Este navegador no da la ubicación'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, label: 'Tu ubicación' }),
      e => {
        const err = new Error(e.code === 1 ? 'No diste permiso para usar tu ubicación.' : e.code === 3 ? 'La ubicación tardó demasiado (¿estás bajo techo?).' : 'No se pudo obtener tu ubicación.');
        err.denied = e.code === 1;
        reject(err);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

/** settings.startMode: 'gps' | 'address' | 'none'. Devuelve { lat, lng, label } o null, y un aviso si algo falló. */
export async function resolveStart(settings) {
  const notes = [];
  if (settings.startMode === 'gps') {
    try { return { start: await currentPosition(), notes }; }
    catch (e) { notes.push(e.message); }
  }
  if ((settings.startMode === 'address' || notes.length) && settings.startAddress) {
    const g = await geocode({ address: settings.startAddress, zone: '' }, settings.city || 'Montevideo');
    if (g) return { start: { lat: g.lat, lng: g.lng, label: settings.startAddress }, notes };
    notes.push('No se encontró la dirección de partida');
  }
  return { start: null, notes };
}

/* ---------------- Ruta ---------------- */

async function osrm(service, coords, query) {
  const path = coords.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${OSRM}${service}/v1/driving/${path}?${query}`, { signal: ctl.signal, referrerPolicy: 'strict-origin-when-cross-origin' });
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error(j.message || j.code);
    return j;
  } finally { clearTimeout(t); }
}

/**
 * Ordena las paradas (con coordenadas) para recorrerlas en el menor tiempo de manejo.
 * Con OSRM: tabla de tiempos reales entre todas las paradas → orden calculado en el teléfono →
 * recorrido por calles en ese orden. Si OSRM no responde, todo se calcula en línea recta.
 * Devuelve { order: [índices], geometry: [[lat,lng]...], distance (m), duration (s) | null, via }.
 */
export async function planRoute(points, start) {
  const nodes = start ? [start, ...points] : points;
  if (points.length >= 2 && nodes.length <= 100) {
    try {
      const table = await osrm('table', nodes, 'annotations=duration');
      const dur = table.durations;
      const ord = orderByCost(nodes.length, !!start, (i, j) => dur[i][j] ?? 1e9);
      const order = start ? ord.map(i => i - 1) : ord;
      const seq = [...(start ? [start] : []), ...order.map(i => points[i])];
      const route = await osrm('route', seq, 'overview=full&geometries=geojson');
      const rt = route.routes[0];
      return {
        order, via: 'osrm',
        geometry: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: rt.distance, duration: rt.duration
      };
    } catch { /* sin conexión o servidor ocupado: cálculo local */ }
  }
  const order = optimizeOrder(points, start);
  const seq = [...(start ? [start] : []), ...order.map(i => points[i])];
  let distance = 0;
  for (let i = 1; i < seq.length; i++) distance += distanceM(seq[i - 1], seq[i]);
  return { order, via: 'local', geometry: seq.map(p => [p.lat, p.lng]), distance: distance * 1.3, duration: null };
}

/* ---------------- Navegación externa ---------------- */

export function navUrl(app, it, city) {
  const has = it.lat != null;
  const text = encodeURIComponent(`${it.address}, ${city || 'Montevideo'}, Uruguay`);
  if (app === 'waze') return has ? `https://waze.com/ul?ll=${it.lat},${it.lng}&navigate=yes` : `https://waze.com/ul?q=${text}&navigate=yes`;
  return has ? `https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${text}&travelmode=driving`;
}

/** Google Maps con varias paradas seguidas (máx. 9 intermedias + destino). */
export function multiStopUrl(stops) {
  const pts = stops.filter(s => s.lat != null).slice(0, 10);
  if (!pts.length) return '';
  const fmt = s => `${s.lat},${s.lng}`;
  const dest = pts[pts.length - 1];
  const way = pts.slice(0, -1).map(fmt).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${fmt(dest)}${way ? `&waypoints=${encodeURIComponent(way)}` : ''}&travelmode=driving`;
}
