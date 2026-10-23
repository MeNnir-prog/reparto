// app.js — Interfaz de la PWA "Reparto · Reportes"
import * as DB from './db.js';
import {
  normalize, cleanSpaces, splitAddress, fullAddress, parseCedula, validatePackage, cleanPackage,
  REASONS, reasonSentence, buildDeliveredMessage, buildFailedMessage, normalizePhone, isValidPhone,
  whatsappUrl, matchesQuery, markDuplicates, buildRows, rowsFromText, STATUS_LABEL, SEND_LABEL,
  todayISO, dayStats, findPackageConflicts, baseKey, dupKey, ROLE_LABEL, ROLE_CYCLE, fmtKm, fmtMin
} from './logic.js';
import { navUrl, multiStopUrl, purgeGeoCache } from './map.js';

const APP_VERSION = '1.2.0';
const DEFAULT_SETTINGS = {
  name: 'Tía', phone: '', linkMode: 'app', retentionDays: 7, apiEnabled: false, apiUrl: '', apiToken: '',
  city: 'Montevideo', startMode: 'gps', startAddress: '', mapConsent: false
};

/* ================= Estado ================= */
const S = {
  settings: { ...DEFAULT_SETTINGS },
  day: null, items: [],
  view: 'route', params: {},
  filter: 'pending', query: '',
  draft: null,          // reporte en edición
  imp: null,            // importación en curso
  sendFile: null,       // File de la foto listo para compartir
  photoUrls: new Map(), // id -> objectURL
  mapBusy: null,        // texto de progreso al armar la ruta
  mapSel: null,         // parada elegida en el mapa
  pick: null            // id de la parada que se está ubicando a mano en el mapa
};

/* ================= Utilidades UI ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const fmtDateTime = ts => ts ? new Date(ts).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function openModal(html) {
  const m = $('#modal'); m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false;
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !$('#modal .sheet[data-sticky]')) closeModal(); });

function ask(title, body, { ok = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) {
  return new Promise(resolve => {
    openModal(`<h2>${esc(title)}</h2><div class="stack">${body ? `<p>${body}</p>` : ''}
      <button class="btn ${danger ? 'bad' : 'primary'}" id="askOk">${esc(ok)}</button>
      <button class="btn" id="askNo">${esc(cancel)}</button></div>`);
    $('#askOk').onclick = () => { closeModal(); resolve(true); };
    $('#askNo').onclick = () => { closeModal(); resolve(false); };
  });
}

function sendPill(it) {
  if (it.status === 'pending' || !it.sendStatus || it.sendStatus === 'none') return '';
  const cls = { prepared: 'warn', awaiting: 'warn', sent: 'ok', error: 'bad' }[it.sendStatus] || 'gray';
  const label = it.sendStatus === 'sent' && it.sentVia === 'api' ? 'Enviado (API)' : SEND_LABEL[it.sendStatus];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}
function statusPill(it) {
  const cls = { pending: 'gray', delivered: 'ok', failed: 'bad' }[it.status];
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[it.status])}</span>`;
}

async function photoUrl(id) {
  if (!id) return '';
  if (S.photoUrls.has(id)) return S.photoUrls.get(id);
  const blob = await DB.getPhoto(id);
  if (!blob) return '';
  const u = URL.createObjectURL(blob); S.photoUrls.set(id, u); return u;
}

/** Comprime la foto (máx 1600 px, JPEG). Al re-dibujarla se eliminan los metadatos EXIF (incluida la ubicación GPS). */
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo procesar la foto')), 'image/jpeg', 0.78);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la foto')); };
    img.src = url;
  });
}

/* ================= Datos ================= */
async function loadSettings() {
  S.settings = { ...DEFAULT_SETTINGS, ...(await DB.getMeta('settings', {})) };
}
async function saveSettings() { await DB.setMeta('settings', S.settings); }

async function loadActiveDay() {
  const id = await DB.getMeta('activeDayId');
  S.day = id ? await DB.getDay(id) : null;
  S.items = S.day ? await DB.itemsOfDay(S.day.id) : [];
}
async function reloadItems() { S.items = S.day ? await DB.itemsOfDay(S.day.id) : []; updateBadge(); }
const itemById = id => S.items.find(i => i.id === id);

function updateBadge() {
  const n = dayStats(S.items).unsent;
  const b = $('#unsentBadge'); b.hidden = !n; b.textContent = n;
}

async function purgeOld() {
  const days = await DB.listDays();
  const limit = Date.now() - S.settings.retentionDays * 86400000;
  let n = 0;
  for (const d of days) if (d.createdAt < limit && d.id !== S.day?.id) { await DB.deleteDay(d.id); n++; }
  await purgeGeoCache(S.settings.retentionDays);
  return n;
}

async function saveDraft() {
  if (!S.draft) { await DB.setMeta('draft', null); return; }
  await DB.setMeta('draft', S.draft);
}

/* ================= Navegación ================= */
// La URL nunca contiene datos: el estado de navegación se guarda en history.state.
function go(view, params = {}, replace = false) {
  S.view = view; S.params = params;
  const st = { view, params };
  if (replace) history.replaceState(st, ''); else history.pushState(st, '');
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', e => {
  const st = e.state || { view: 'route', params: {} };
  S.view = st.view; S.params = st.params || {}; closeModal();
  if (S.draft && !['deliver', 'fail', 'confirm'].includes(S.view)) dropDraft();
  render();
});
// Al salir del formulario sin confirmar, se descarta el borrador (y su foto nueva).
async function dropDraft() { await discardDraftPhoto(); S.draft = null; await saveDraft(); }
document.querySelectorAll('#tabbar .tab').forEach(b => b.addEventListener('click', () => go(b.dataset.tab, {}, true)));

const FORM_VIEWS = ['deliver', 'fail', 'confirm', 'send', 'detail'];
function render() {
  document.body.classList.toggle('hide-tabs', FORM_VIEWS.includes(S.view));
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.view));
  const views = { route: vRoute, map: vMap, detail: vDetail, deliver: vDeliver, fail: vFail, confirm: vConfirm, send: vSend, import: vImport, history: vHistory, settings: vSettings, help: vHelp };
  if (S.view !== 'map' && MAP) closeMap();
  (views[S.view] || vRoute)();
  updateBadge();
}
function setTop(title, sub = '', extra = '') {
  $('#topbar').innerHTML = `<h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}`;
}
const backBtn = (label = 'Volver') => `<button class="back" data-act="back">‹ ${esc(label)}</button>`;

/* ================= Vista: Reparto ================= */
function vRoute() {
  if (!S.day) {
    setTop('Reparto');
    $('#view').innerHTML = `<div class="empty"><div class="big">📦</div><h2>No hay jornada cargada</h2>
      <p class="muted">Importá las capturas de la lista de direcciones del día.</p></div>
      <div class="stack"><button class="btn primary big" data-act="tab" data-tab="import">📥 Importar lista del día</button>
      ${!S.settings.phone ? `<button class="btn" data-act="tab" data-tab="settings">⚙️ Configurar WhatsApp de destino</button>` : ''}
      <button class="btn link" data-act="tab" data-tab="help">¿Cómo funciona?</button></div>`;
    return;
  }
  const st = dayStats(S.items);
  const done = st.delivered + st.failed;
  const pct = st.total ? Math.round(done / st.total * 100) : 0;
  setTop(`Jornada ${fmtDate(S.day.date)}`,
    `<b>${done}/${st.total}</b> reportadas${st.unsent ? ` · <span class="top-warn">${st.unsent} sin enviar</span>` : ''}`,
    `<div class="progress" aria-label="Progreso ${pct}%"><i style="width:${pct}%"></i></div>`);
  const chips = [
    ['pending', `Pendientes ${st.pending}`], ['unsent', `Sin enviar ${st.unsent}`], ['delivered', `Entregados ${st.delivered}`],
    ['failed', `No entregados ${st.failed}`], ['all', `Todas ${st.total}`]
  ];
  const r = S.day.route;
  const next = sortedItems().find(i => i.status === 'pending');
  $('#view').innerHTML = `
    ${!S.settings.phone ? `<div class="alert warn" style="margin-bottom:10px">Falta configurar el número de WhatsApp de destino. <button class="btn small link" data-act="tab" data-tab="settings">Configurar</button></div>` : ''}
    <section class="card stats4">
      <div class="stat"><b>${st.total}</b><span>Paradas</span></div>
      <div class="stat"><b>${st.pending}</b><span>Pendientes</span></div>
      <div class="stat"><b class="c-ok">${st.delivered}</b><span>Entregadas</span></div>
      <div class="stat"><b class="c-bad">${st.failed}</b><span>No entregadas</span></div>
    </section>
    ${r ? `<section class="card routecard">
        <div class="row" style="align-items:center"><div><div class="rc-title">🗺️ Ruta optimizada</div>
          <div class="small muted">${r.count} paradas · ${fmtKm(r.distance)}${r.duration ? ` · ${fmtMin(r.duration)}` : ''} · ${routeFrom(r)}</div></div>
          <button class="btn small" style="flex:none" data-act="tab" data-tab="map">Ver mapa</button></div>
        ${st.pending ? `<button class="btn small" style="width:100%;margin-top:10px" data-act="route-go">📍 Recalcular desde ${S.settings.startMode === 'gps' ? 'donde estoy' : 'el inicio'}</button>` : ''}
        ${next ? `<div class="next"><span class="muted small">Próxima parada</span>
          <button class="next-btn" data-act="open" data-id="${next.id}">${next.routeOrder != null ? `<span class="num">${next.routeOrder + 1}</span>` : ''}
          <span><b>${esc(next.address)}</b>${next.orderNo ? `<span class="small muted"> · #${esc(next.orderNo)}${next.company ? ' · ' + esc(next.company) : ''}</span>` : ''}</span></button>
          <a class="btn primary" href="${esc(navUrl('google', next, S.settings.city))}" target="_blank" rel="noopener">🧭 Ir a la próxima</a></div>` : ''}
      </section>`
    : st.pending > 1 ? `<button class="btn primary big" data-act="route-go">🗺️ Armar ruta optimizada</button>` : ''}
    <div class="search"><input id="q" type="search" placeholder="🔎 Buscar calle, pedido, empresa…" value="${esc(S.query)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"></div>
    <div class="chips" role="tablist">${chips.map(([k, l]) => `<button class="chip ${S.filter === k ? 'active' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
    <ul class="list" id="list"></ul>`;
  $('#q').addEventListener('input', e => { S.query = e.target.value; renderList(); });
  renderList();
}

function itemFlags() {
  const byKey = {}, byBase = {};
  for (const it of S.items) {
    const k = dupKey(fullAddress(it)), b = baseKey(it.address);
    (byKey[k] = byKey[k] || []).push(it.id); (byBase[b] = byBase[b] || []).push(it.id);
  }
  return { byKey, byBase };
}

/** Paradas en orden de ruta (las que no tienen orden, al final, en el orden de la lista). */
function sortedItems() {
  return S.items.slice().sort((a, b) => (a.routeOrder ?? 1e6) - (b.routeOrder ?? 1e6) || a.order - b.order);
}

function stopLi(it, dups = 0) {
  const n = it.status === 'pending' && it.routeOrder != null ? it.routeOrder + 1 : '';
  return `<li><button class="addr ${it.status}" data-act="open" data-id="${it.id}">
    <span class="num ${it.status}">${it.status === 'delivered' ? '✓' : it.status === 'failed' ? '✕' : n}</span>
    <span class="main">
      ${it.orderNo || it.company ? `<div class="order">${it.orderNo ? `<span class="mono">#${esc(it.orderNo)}</span>` : ''}${it.orderNo && it.company ? ' · ' : ''}${it.company ? `<span class="co">${esc(it.company)}</span>` : ''}</div>` : ''}
      <div class="street">${esc(it.address)}</div>
      <div class="meta">${it.refs ? `<span class="ref">${esc(it.refs)}</span>` : ''}
        ${it.zone ? `<span>${esc(it.zone)}</span>` : ''}
        ${it.status !== 'pending' ? statusPill(it) : ''} ${sendPill(it)}
        ${it.geo === 'fail' ? '<span class="pill warn">Sin ubicar</span>' : it.geo === 'approx' ? '<span class="pill gray">Ubicación aprox.</span>' : ''}
        ${dups > 1 ? `<span class="pill warn">Repetida ×${dups}</span>` : ''}</div></span>
    <span class="chev">›</span></button></li>`;
}

function renderList() {
  const ul = $('#list'); if (!ul) return;
  const q = S.query.trim();
  let list = sortedItems();
  if (!q) {
    if (S.filter === 'pending') list = list.filter(i => i.status === 'pending');
    else if (S.filter === 'delivered') list = list.filter(i => i.status === 'delivered');
    else if (S.filter === 'failed') list = list.filter(i => i.status === 'failed');
    else if (S.filter === 'unsent') list = list.filter(i => i.status !== 'pending' && i.sendStatus !== 'sent');
  } else list = list.filter(i => matchesQuery(i, q));
  const { byKey } = itemFlags();
  if (!list.length) {
    ul.innerHTML = `<li class="empty muted">${q ? 'No se encontró ninguna dirección. Probá con menos palabras o solo el número de puerta.' :
      S.filter === 'pending' ? '🎉 No quedan direcciones pendientes.' : 'No hay direcciones en este filtro.'}</li>`;
    return;
  }
  ul.innerHTML = (q ? `<li class="muted small">Buscando en todas las direcciones (${list.length})</li>` : '') +
    list.map(it => stopLi(it, byKey[dupKey(fullAddress(it))]?.length || 0)).join('');
}

/* ================= Vista: Mapa y ruta ================= */
let MAP = null, GEO_WATCH = null, ME = null;

function closeMap() {
  if (GEO_WATCH != null) { navigator.geolocation.clearWatch(GEO_WATCH); GEO_WATCH = null; }
  if (MAP) { MAP.remove(); MAP = null; }
  ME = null;
}

/** Punto azul con tu ubicación, actualizado mientras el mapa está abierto. */
function watchMe(L, map) {
  if (!navigator.geolocation || S.settings.startMode !== 'gps') return;
  const draw = pos => {
    if (MAP !== map) return;
    const ll = [pos.lat, pos.lng];
    if (!ME) {
      ME = {
        acc: L.circle(ll, { radius: pos.acc || 30, color: '#1d6fd1', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map),
        dot: L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me" title="Vos"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 2000, interactive: false }).addTo(map)
      };
    } else { ME.dot.setLatLng(ll); ME.acc.setLatLng(ll).setRadius(pos.acc || 30); }
  };
  if (S.myPos) draw(S.myPos);
  GEO_WATCH = navigator.geolocation.watchPosition(
    p => { S.myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, label: 'Tu ubicación' }; draw(S.myPos); },
    () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

function routeFrom(r) {
  if (!r?.start) return 'desde la primera parada';
  return r.start.label === 'Tu ubicación' ? `desde tu ubicación (${fmtTime(r.at)})` : `desde ${esc(r.start.label)}`;
}

function vMap() {
  if (!S.day) {
    setTop('Mapa');
    $('#view').innerHTML = `<div class="empty"><div class="big">🗺️</div><h2>No hay jornada cargada</h2>
      <p class="muted">Importá la lista del día para armar la ruta.</p></div>
      <button class="btn primary big" data-act="tab" data-tab="import">📥 Importar lista del día</button>`;
    return;
  }
  const r = S.day.route;
  const pend = sortedItems().filter(i => i.status === 'pending');
  const missing = pend.filter(i => i.lat == null && i.geo === 'fail');
  const approx = pend.filter(i => i.geo === 'approx');
  const pickIt = S.pick && itemById(S.pick);
  setTop('Mapa y ruta', r ? `${r.count} paradas · ${fmtKm(r.distance)}${r.duration ? ` · ${fmtMin(r.duration)}` : ' (en línea recta)'} · ${routeFrom(r)}`
    : `${pend.length} pendientes · todavía sin ordenar`);
  $('#view').innerHTML = `
    ${pickIt ? `<div class="alert info pickbar">📍 Tocá en el mapa dónde queda <b>${esc(pickIt.address)}</b>
      <button class="btn small" data-act="map-pick-cancel">Cancelar</button></div>` : ''}
    <div id="mapbox" class="mapbox"><div class="map-msg"><span class="spinner"></span> Cargando mapa…</div></div>
    <div id="mapSel"></div>
    ${S.mapBusy ? `<div class="card" id="mapBusy" style="margin-top:10px"><span class="spinner"></span> <span>${esc(S.mapBusy)}</span></div>` : `
    <div class="stack" style="margin-top:12px">
      <button class="btn primary big" data-act="route-build" ${pend.length ? '' : 'disabled'}>⚡ ${r ? 'Recalcular ruta' : 'Armar ruta optimizada'}</button>
      ${r && pend.some(i => i.lat != null) ? `<a class="btn" href="${esc(multiStopUrl(pend))}" target="_blank" rel="noopener">🧭 Navegar las próximas ${Math.min(10, pend.filter(i => i.lat != null).length)} en Google Maps</a>` : ''}
      <div class="small muted">Inicio: ${S.settings.startMode === 'gps' ? 'tu ubicación actual' : S.settings.startMode === 'address' && S.settings.startAddress ? esc(S.settings.startAddress) : 'la primera parada'} · <button class="btn small link inline" data-act="tab" data-tab="settings">cambiar</button></div>
    </div>`}
    ${missing.length ? `<h2>⚠️ No se encontraron (${missing.length})</h2>
      <p class="small muted">Corregí la dirección o marcala a mano en el mapa.</p>
      <ul class="list">${missing.map(it => `<li class="card">${it.orderNo ? `<div class="small"><b>#${esc(it.orderNo)}</b>${it.company ? ' · ' + esc(it.company) : ''}</div>` : ''}
        <div style="font-weight:650">${esc(it.address)}</div>${it.zone ? `<div class="small muted">${esc(it.zone)}</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="btn small" data-act="map-pick" data-id="${it.id}">📍 Marcar en el mapa</button>
        <button class="btn small" data-act="edit-addr" data-id="${it.id}">✏️ Corregir</button></div></li>`).join('')}</ul>` : ''}
    ${approx.length ? `<p class="small muted" style="margin-top:12px">ℹ️ ${approx.length} ${approx.length === 1 ? 'parada quedó' : 'paradas quedaron'} ubicadas solo por la calle (sin el número exacto). Se marcan con borde punteado; podés moverlas desde la parada.</p>` : ''}
    ${pend.length ? `<h2>Orden de visita</h2><ul class="list">${pend.map(it => stopLi(it)).join('')}</ul>` : '<p class="muted center">🎉 No quedan paradas pendientes.</p>'}
    <p class="small muted center" style="margin-top:16px">Mapa © colaboradores de OpenStreetMap · Ruta: OSRM</p>`;
  drawMap();
}

async function drawMap() {
  const box = $('#mapbox'); if (!box) return;
  let L;
  try { L = await (await import('./map.js')).loadLeaflet(); }
  catch (e) { box.innerHTML = `<div class="map-msg">${esc(e.message)}</div>`; return; }
  if (S.view !== 'map' || !$('#mapbox')) return;
  closeMap();
  const el = $('#mapbox'); el.innerHTML = '';
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  MAP = map;
  watchMe(L, map);
  if (S.settings.startMode === 'gps' && navigator.geolocation) {
    const b = document.createElement('button');
    b.className = 'locbtn'; b.type = 'button'; b.title = 'Ir a mi ubicación'; b.setAttribute('aria-label', 'Ir a mi ubicación'); b.textContent = '◎';
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => {
      if (S.myPos) map.setView([S.myPos.lat, S.myPos.lng], Math.max(map.getZoom(), 15));
      else toast('Buscando tu ubicación… Si no aparece, revisá el permiso de ubicación de Safari.', 3500);
    };
    el.appendChild(b);
  }
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const pts = [];
  const r = S.day.route;
  if (r?.geometry?.length) { L.polyline(r.geometry, { color: '#1f8a4c', weight: 5, opacity: 0.75 }).addTo(map); }
  if (r?.start) {
    L.marker([r.start.lat, r.start.lng], { icon: L.divIcon({ className: '', html: '<div class="pin start" title="Inicio de la ruta">▶</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: -100 }).addTo(map);
    pts.push([r.start.lat, r.start.lng]);
  }
  for (const it of sortedItems()) {
    if (it.lat == null) continue;
    const label = it.status === 'delivered' ? '✓' : it.status === 'failed' ? '✕' : it.routeOrder != null ? it.routeOrder + 1 : '•';
    const cls = `pin ${it.status} ${it.geo === 'approx' ? 'approx' : ''} ${S.mapSel === it.id ? 'sel' : ''}`;
    const m = L.marker([it.lat, it.lng], {
      icon: L.divIcon({ className: '', html: `<div class="${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      zIndexOffset: it.status === 'pending' ? 1000 - (it.routeOrder ?? 900) : 0
    }).addTo(map);
    m.on('click', () => { S.mapSel = it.id; renderMapSel(); });
    pts.push([it.lat, it.lng]);
  }
  if (pts.length) map.fitBounds(pts, { padding: [28, 28], maxZoom: 16 });
  else map.setView([-34.88, -56.16], 12);
  if (S.pick) {
    el.classList.add('picking');
    map.once('click', e => placeManual(S.pick, e.latlng));
  }
  renderMapSel();
}

function renderMapSel() {
  const box = $('#mapSel'); if (!box) return;
  const it = S.mapSel && itemById(S.mapSel);
  if (!it) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card selcard">
    <div class="row" style="align-items:flex-start"><div>
      ${it.orderNo || it.company ? `<div class="order">${it.routeOrder != null && it.status === 'pending' ? `<b>Parada ${it.routeOrder + 1}</b> · ` : ''}${it.orderNo ? `<span class="mono">#${esc(it.orderNo)}</span>` : ''}${it.company ? ` · ${esc(it.company)}` : ''}</div>` : ''}
      <div style="font-size:18px;font-weight:700">${esc(it.address)}</div>
      ${it.refs ? `<span class="ref small">${esc(it.refs)}</span>` : ''} ${it.status !== 'pending' ? statusPill(it) : ''}</div>
      <button class="iconbtn" data-act="map-sel-close" aria-label="Cerrar" style="flex:none">✕</button></div>
    <div class="row" style="margin-top:10px"><button class="btn ok" data-act="open" data-id="${it.id}">Abrir</button>
      <a class="btn" href="${esc(navUrl('google', it, S.settings.city))}" target="_blank" rel="noopener">🧭 Ir</a></div></div>`;
}

async function placeManual(id, latlng) {
  const it = itemById(id); S.pick = null;
  if (!it) return vMap();
  Object.assign(it, { lat: latlng.lat, lng: latlng.lng, geo: 'manual' });
  await DB.putItem(it); await reloadItems();
  toast(S.day.route ? '📍 Ubicación guardada. Tocá “Recalcular ruta” para incluirla.' : '📍 Ubicación guardada', 3500);
  S.mapSel = id; vMap();
}

/** Sin ubicación: explicar cómo activarla en el iPhone y dejar seguir sin ella. */
function askNoGps(err) {
  const fallback = S.settings.startAddress ? `desde <b>${esc(S.settings.startAddress)}</b>` : 'desde la parada que convenga';
  return ask('No se pudo usar tu ubicación', `${esc(err.message)}<br><br>
    ${err.denied ? `Para activarla en el iPhone:<ol class="steps small">
      <li><b>Ajustes → Privacidad y seguridad → Localización</b>: activada.</li>
      <li>Ahí mismo, <b>Sitios web de Safari</b> → <b>Al usar la app</b>, y <b>Ubicación exacta</b> activada.</li>
      <li>Volvé a la app y tocá de nuevo <b>Armar ruta</b>. Si sigue sin preguntar: Ajustes → Safari → Ubicación → Preguntar.</li></ol>`
      : 'Probá de nuevo al aire libre o con el GPS activado.'}
    <br>¿Armar la ruta igual, ${fallback}?`, { ok: 'Armar igual', cancel: 'Cancelar' });
}

function setMapBusy(text) {
  S.mapBusy = text;
  const b = $('#mapBusy span:last-child');
  if (b) b.textContent = text; else if (S.view === 'map') vMap();
}

async function buildRoute() {
  if (S.mapBusy) return;
  if (!S.settings.mapConsent) {
    const ok = await ask('Armar la ruta',
      'Para ubicar las paradas en el mapa y calcular el recorrido, se envían <b>calle, número y barrio</b> a OpenStreetMap (buscador Nominatim y ruteo OSRM). <b>No</b> se envían nombres, teléfonos, cédulas ni números de pedido.',
      { ok: 'Entendido, continuar' });
    if (!ok) return;
    S.settings.mapConsent = true; await saveSettings();
  }
  if (!navigator.onLine) return toast('Sin conexión: para armar la ruta hace falta internet.', 4000);
  if (S.view !== 'map') go('map', {}, true);
  const M = await import('./map.js');
  const pend = S.items.filter(i => i.status === 'pending');
  try {
    // La ubicación se pide primero (justo después de tocar el botón), no después de buscar todas las direcciones
    let start = null;
    const notes = [];
    if (S.settings.startMode === 'gps') {
      setMapBusy('Obteniendo tu ubicación…');
      try { start = await M.currentPosition(); S.myPos = start; }
      catch (e) {
        S.mapBusy = null; if (S.view === 'map') vMap();
        if (!(await askNoGps(e))) return;
        setMapBusy('Buscando direcciones…');
      }
    }
    setMapBusy('Buscando direcciones…');
    // Reintentar las que fallaron antes solo si se corrigió la dirección (geo vuelve a null)
    const res = await M.geocodeItems(pend, S.settings.city || 'Montevideo', (i, n) => setMapBusy(`Buscando direcciones ${i} de ${n}…`));
    if (!start && S.settings.startMode !== 'none' && S.settings.startAddress) {
      setMapBusy('Buscando la dirección de partida…');
      const r0 = await M.resolveStart({ ...S.settings, startMode: 'address' });
      start = r0.start; notes.push(...r0.notes);
    }
    const located = pend.filter(i => i.lat != null);
    if (!located.length) throw new Error('No se pudo ubicar ninguna dirección. Revisá la ciudad en Ajustes o corregí las direcciones.');
    setMapBusy('Calculando el mejor recorrido…');
    const plan = await M.planRoute(located.map(i => ({ lat: i.lat, lng: i.lng })), start);
    for (const it of S.items) it.routeOrder = null;
    plan.order.forEach((idx, k) => { located[idx].routeOrder = k; });
    let k = plan.order.length;
    for (const it of pend) if (it.routeOrder == null) it.routeOrder = k++; // sin ubicar: al final
    await DB.putItems(S.items);
    S.day.route = { geometry: plan.geometry, distance: plan.distance, duration: plan.duration, via: plan.via, start, at: Date.now(), count: located.length };
    await DB.putDay(S.day);
    const msg = [`✓ Ruta lista: ${located.length} paradas`];
    if (res.missing || pend.length - located.length) msg.push(`${pend.length - located.length} sin ubicar`);
    if (plan.via === 'local') msg.push('calculada sin el servidor de rutas (en línea recta)');
    toast(msg.join(' · ') + (notes.length ? `. ${notes.join('. ')}` : ''), 5000);
  } catch (e) {
    toast(e.message || 'No se pudo armar la ruta', 5000);
  } finally {
    S.mapBusy = null;
    await reloadItems();
    if (S.view === 'map') vMap();
  }
}

/* ================= Vista: Detalle ================= */
async function vDetail() {
  const it = itemById(S.params.id);
  if (!it) return go('route', {}, true);
  setTop(it.status === 'pending' && it.routeOrder != null ? `Parada ${it.routeOrder + 1}` : 'Parada');
  const { byBase } = itemFlags();
  const siblings = (byBase[baseKey(it.address)] || []).filter(id => id !== it.id).map(itemById);
  const ph = it.photoId ? await photoUrl(it.photoId) : '';
  const ciPrev = S.quickCi?.id === it.id ? S.quickCi.value : '';
  $('#view').innerHTML = `${backBtn()}
    <div class="card">
      ${it.orderNo || it.company ? `<div class="order big">${it.orderNo ? `<span class="mono">#${esc(it.orderNo)}</span>` : ''}${it.orderNo && it.company ? ' · ' : ''}${it.company ? `<span class="co">${esc(it.company)}</span>` : ''}</div>` : ''}
      <div style="font-size:26px;font-weight:700;line-height:1.2">${esc(it.address)}</div>
      ${it.refs ? `<div style="margin-top:8px;font-size:20px"><span class="ref">${esc(it.refs)}</span></div>` : ''}
      ${it.zone ? `<div class="muted" style="margin-top:6px">${esc(it.zone)}</div>` : ''}
      <div class="row" style="margin-top:12px">
        <a class="btn small" href="${esc(navUrl('google', it, S.settings.city))}" target="_blank" rel="noopener">🧭 Google Maps</a>
        <a class="btn small" href="${esc(navUrl('waze', it, S.settings.city))}" target="_blank" rel="noopener">🚗 Waze</a></div>
      <details style="margin-top:10px"><summary class="small muted">Texto original y ubicación</summary>
        <div class="small muted" style="margin-top:6px">“${esc(it.original)}”</div>
        ${it.crop ? `<img src="${it.crop}" alt="Recorte de la captura" style="width:100%;margin-top:6px;border-radius:6px;background:#fff">` : ''}
        <div class="small muted" style="margin-top:6px">${it.geo === 'exact' ? '📍 Ubicada en el mapa' : it.geo === 'approx' ? '📍 Ubicación aproximada (solo la calle)' : it.geo === 'manual' ? '📍 Marcada a mano' : it.geo === 'fail' ? '⚠️ No se encontró en el mapa' : 'Todavía no se ubicó en el mapa'}</div>
      </details>
      <div class="row" style="margin-top:4px"><button class="btn small link" data-act="edit-addr" data-id="${it.id}" style="padding-left:0">✏️ Corregir datos</button>
        <button class="btn small link" data-act="map-pick" data-id="${it.id}">📍 ${it.lat != null ? 'Mover en el mapa' : 'Marcar en el mapa'}</button></div>
    </div>
    ${siblings.length ? `<div class="alert warn" style="margin-top:10px">⚠️ Hay ${siblings.length + 1} registros en ${esc(it.address)}:
      ${[it, ...siblings].map(s => `<b>${esc(s.refs || 'sin referencia')}</b>${s.orderNo ? ` (#${esc(s.orderNo)})` : ''}${s.status !== 'pending' ? ` (${STATUS_LABEL[s.status].toLowerCase()})` : ''}`).join(', ')}. Verificá la referencia antes de reportar.</div>` : ''}
    ${it.status === 'pending' ? `
      <div class="card" style="margin-top:12px">
        <label class="field" style="margin-top:0"><span>Cédula de quien recibe</span>
          <input id="q-ci" class="mono" inputmode="numeric" autocomplete="off" enterkeyhint="done" placeholder="Ej: 1234567-2" value="${esc(ciPrev)}">
          <div id="q-ci-msg" class="hint">Con o sin puntos y guion.</div></label>
        <button class="btn ok big" style="margin-top:12px" data-act="quick-deliver" data-id="${it.id}">✅ Entregado</button>
      </div>
      <div class="stack" style="margin-top:10px">
        <button class="btn bad" data-act="start" data-type="failed" data-id="${it.id}">❌ No entregado</button>
      </div>` : `
      <h2>Reporte</h2>
      <div class="card stack">
        <div>${statusPill(it)} ${sendPill(it)}</div>
        <dl class="kv"><dt>Paquete</dt><dd class="mono">#${esc(it.pkg)}</dd>
        ${it.status === 'delivered' ? `<dt>Cédula</dt><dd class="mono">${esc(it.cedula)}</dd>` : `<dt>Motivo</dt><dd>${esc(reasonSentence(it.reasonCode, it.reasonText))}</dd>`}
        <dt>Hora</dt><dd>${fmtTime(it.reportedAt)}</dd>
        ${it.sendAttempts ? `<dt>Intentos</dt><dd>${it.sendAttempts}</dd>` : ''}</dl>
        ${ph ? `<img class="photo" src="${ph}" alt="Foto de evidencia">` : ''}
        <div class="bubble">${esc(it.message)}</div>
      </div>
      <div class="stack" style="margin-top:12px">
        ${it.sendStatus !== 'sent' ? `<button class="btn wa big" data-act="goto-send" data-id="${it.id}">📤 Enviar por WhatsApp</button>` : ''}
        ${it.sendStatus !== 'sent' ? `<button class="btn" data-act="mark-sent" data-id="${it.id}">Ya lo envié: marcar como enviado</button>` : ''}
        <button class="btn" data-act="start" data-type="${it.status}" data-id="${it.id}" data-correct="1">✏️ Corregir reporte</button>
        <button class="btn danger-outline" data-act="reset" data-id="${it.id}">↩︎ Volver a pendiente</button>
      </div>`}`;
  const ci = $('#q-ci');
  if (ci) {
    const upd = () => {
      S.quickCi = { id: it.id, value: ci.value };
      const r = parseCedula(ci.value), m = $('#q-ci-msg');
      if (!ci.value.trim()) { m.className = 'hint'; m.textContent = 'Con o sin puntos y guion.'; }
      else if (!r.ok) { m.className = 'err'; m.textContent = r.error; }
      else if (r.validDigit) { m.className = 'okmsg'; m.textContent = `Se enviará: ${r.formatted} ✓`; }
      else { m.className = 'err'; m.textContent = `Se enviará: ${r.formatted} — ⚠️ ${r.error}`; }
    };
    ci.addEventListener('input', upd);
    ci.addEventListener('keydown', e => { if (e.key === 'Enter') quickDeliver(it.id); });
    if (ciPrev) upd();
  }
}

/** Entregado desde la pantalla de la parada: con pedido de la lista + cédula válida va directo a revisar. */
async function quickDeliver(id) {
  const it = itemById(id); if (!it) return;
  const value = $('#q-ci')?.value || '';
  const c = parseCedula(value);
  if (value.trim() && !c.ok) { $('#q-ci-msg').className = 'err'; $('#q-ci-msg').textContent = c.error; $('#q-ci').focus(); return; }
  if (S.draft && S.draft.photoId && S.draft.itemId !== id) await discardDraftPhoto();
  S.draft = { itemId: id, type: 'delivered', correcting: false, pkg: it.orderNo || '', cedula: value, reasonCode: '', reasonText: '', photoId: null, photoIsNew: false };
  await saveDraft();
  S.quickCi = null;
  if (c.ok && validatePackage(S.draft.pkg).ok) { S.draft.pkg = validatePackage(S.draft.pkg).value; await saveDraft(); go('confirm', { id }); }
  else go('deliver', { id });
}

/* ================= Formularios ================= */
async function startDraft(id, type, correcting) {
  const it = itemById(id); if (!it) return;
  if (S.draft && S.draft.photoId && S.draft.itemId !== id) await discardDraftPhoto();
  S.draft = {
    itemId: id, type, correcting: !!correcting,
    pkg: correcting ? it.pkg : (it.orderNo || ''), cedula: correcting && type === 'delivered' ? it.cedula : '',
    reasonCode: correcting && type === 'failed' ? it.reasonCode : '', reasonText: correcting ? (it.reasonText || '') : '',
    photoId: correcting && type === 'failed' ? it.photoId : null, photoIsNew: false
  };
  await saveDraft();
  go(type === 'delivered' ? 'deliver' : 'fail', { id });
}

async function discardDraftPhoto() {
  if (S.draft?.photoId && S.draft.photoIsNew) { const id = S.draft.photoId; S.draft.photoId = null; await DB.deletePhoto(id); S.photoUrls.delete(id); }
}

function addrHeader(it) {
  return `<div class="card" style="margin-bottom:6px">
    ${it.orderNo || it.company ? `<div class="order">${it.orderNo ? `<span class="mono">#${esc(it.orderNo)}</span>` : ''}${it.orderNo && it.company ? ' · ' : ''}${it.company ? `<span class="co">${esc(it.company)}</span>` : ''}</div>` : '<div class="muted small">Dirección</div>'}
    <div style="font-size:20px;font-weight:700">${esc(it.address)} ${it.refs ? `<span class="ref">${esc(it.refs)}</span>` : ''}</div></div>`;
}

function pkgField(d) {
  const it = itemById(d.itemId);
  const fromList = it?.orderNo && cleanPackage(d.pkg) === it.orderNo;
  return `<label class="field"><span>Número de pedido</span>
    <input id="f-pkg" class="mono" inputmode="${d.pkgText ? 'text' : 'numeric'}" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="next" placeholder="Ej: 1567" value="${esc(d.pkg)}">
    <div class="hint">${fromList ? 'Viene de la lista: verificalo con la etiqueta del paquete.' : 'Escribilo tal como aparece en la etiqueta, sin “#”.'} <button type="button" class="btn small link" data-act="pkg-kbd" style="display:inline;padding:0">${d.pkgText ? 'Usar teclado numérico' : '¿Tiene letras?'}</button></div>
    <div class="err" id="pkg-err"></div></label>`;
}

function bindPkg() {
  $('#f-pkg').addEventListener('input', e => { S.draft.pkg = e.target.value; $('#pkg-err').textContent = ''; saveDraft(); });
}

function vDeliver() {
  const it = itemById(S.params.id); const d = S.draft;
  if (!it || !d) return go('route', {}, true);
  setTop('✅ Entregado', esc(fullAddress(it)));
  $('#view').innerHTML = `${backBtn('Cancelar')}${addrHeader(it)}
    ${pkgField(d)}
    <label class="field"><span>Cédula de quien recibe</span>
      <input id="f-ci" class="mono" inputmode="numeric" autocomplete="off" enterkeyhint="done" placeholder="Ej: 1234567-2" value="${esc(d.cedula)}">
      <div class="hint">Con o sin puntos y guion. El último número es el dígito verificador.</div>
      <div id="ci-msg"></div></label>
    <div class="stack" style="margin-top:18px"><button class="btn ok big" data-act="review">Revisar reporte ›</button></div>`;
  bindPkg();
  const ci = $('#f-ci');
  const upd = () => {
    const r = parseCedula(ci.value); const m = $('#ci-msg');
    if (!ci.value.trim()) m.innerHTML = '';
    else if (!r.ok) m.innerHTML = `<div class="err">${esc(r.error)}</div>`;
    else m.innerHTML = r.validDigit ? `<div class="okmsg">Se enviará: ${esc(r.formatted)} ✓</div>` : `<div class="err">Se enviará: ${esc(r.formatted)} — ⚠️ ${esc(r.error)}</div>`;
  };
  ci.addEventListener('input', () => { d.cedula = ci.value; upd(); saveDraft(); });
  upd();
  setTimeout(() => (d.pkg ? $('#f-ci') : $('#f-pkg'))?.focus(), 250);
}

async function vFail() {
  const it = itemById(S.params.id); const d = S.draft;
  if (!it || !d) return go('route', {}, true);
  setTop('❌ No entregado', esc(fullAddress(it)));
  const ph = d.photoId ? await photoUrl(d.photoId) : '';
  $('#view').innerHTML = `${backBtn('Cancelar')}${addrHeader(it)}
    ${pkgField(d)}
    <div class="field"><span>Motivo</span><div class="reasons">
      ${REASONS.map(r => `<label class="reason ${d.reasonCode === r.code ? 'sel' : ''}"><input type="radio" name="reason" value="${r.code}" ${d.reasonCode === r.code ? 'checked' : ''}>${esc(r.label)}</label>`).join('')}
    </div><div class="err" id="reason-err"></div></div>
    <label class="field" id="other-wrap" ${d.reasonCode === 'otro' ? '' : 'hidden'}><span>Describí el motivo</span>
      <textarea id="f-other" placeholder="Ej: el portero no permitió el ingreso">${esc(d.reasonText)}</textarea>
      <div class="hint" id="other-prev"></div></label>
    <div class="field"><span>Foto de evidencia</span>
      ${ph ? `<img class="photo" src="${ph}" alt="Foto"><div class="row" style="margin-top:8px">
        <label class="btn small" for="in-cam">📷 Otra foto</label><label class="btn small" for="in-gal">🖼️ Galería</label></div>`
      : `<div class="row"><label class="btn primary" for="in-cam">📷 Tomar foto</label><label class="btn" for="in-gal">🖼️ Galería</label></div>`}
      <input type="file" id="in-cam" class="hidden-input" accept="image/*" capture="environment">
      <input type="file" id="in-gal" class="hidden-input" accept="image/*">
      <div class="hint">La foto queda guardada solo en este teléfono. Se le quitan los datos de ubicación.</div>
      <div class="err" id="photo-err"></div></div>
    <div class="stack" style="margin-top:18px"><button class="btn bad big" data-act="review">Revisar reporte ›</button></div>`;
  bindPkg();
  document.querySelectorAll('input[name=reason]').forEach(r => r.addEventListener('change', () => {
    d.reasonCode = r.value; saveDraft();
    document.querySelectorAll('.reason').forEach(l => l.classList.toggle('sel', l.querySelector('input').checked));
    $('#other-wrap').hidden = d.reasonCode !== 'otro'; $('#reason-err').textContent = '';
    if (d.reasonCode === 'otro') setTimeout(() => $('#f-other').focus(), 100);
  }));
  const other = $('#f-other');
  const prev = () => { $('#other-prev').textContent = other.value.trim() ? 'Se enviará: ' + reasonSentence('otro', other.value) : ''; };
  other.addEventListener('input', () => { d.reasonText = other.value; prev(); saveDraft(); }); prev();
  for (const id of ['in-cam', 'in-gal']) $('#' + id).addEventListener('change', async e => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      toast('Procesando foto…');
      const blob = await compressPhoto(f);
      await discardDraftPhoto();
      const pid = DB.uid(); await DB.putPhoto(pid, blob);
      d.photoId = pid; d.photoIsNew = true; await saveDraft();
      vFail();
    } catch (err) { $('#photo-err').textContent = err.message; }
  });
}

async function review() {
  const d = S.draft; const it = itemById(d.itemId);
  const p = validatePackage(d.pkg);
  let bad = false;
  if (!p.ok) { $('#pkg-err').textContent = p.error; bad = true; }
  if (d.type === 'delivered') {
    const c = parseCedula(d.cedula);
    if (!c.ok) { $('#ci-msg').innerHTML = `<div class="err">${esc(c.error)}</div>`; bad = true; }
  } else {
    if (!d.reasonCode) { $('#reason-err').textContent = 'Elegí un motivo'; bad = true; }
    else if (d.reasonCode === 'otro' && !cleanSpaces(d.reasonText)) { $('#reason-err').textContent = 'Escribí el motivo'; bad = true; }
    if (!d.photoId && !bad) {
      const ok = await ask('Falta la foto', 'El reporte de no entrega normalmente lleva foto. ¿Seguir sin foto?', { ok: 'Seguir sin foto', cancel: 'Sacar foto' });
      if (!ok) return;
    }
  }
  if (bad) { window.scrollTo(0, 0); return; }
  d.pkg = p.value; await saveDraft();
  go('confirm', { id: it.id });
}

async function vConfirm() {
  const d = S.draft; const it = d && itemById(d.itemId);
  if (!it) return go('route', {}, true);
  const addr = fullAddress(it);
  const ci = d.type === 'delivered' ? parseCedula(d.cedula) : null;
  const msg = d.type === 'delivered' ? buildDeliveredMessage({ pkg: d.pkg, address: addr, cedula: ci.formatted })
    : buildFailedMessage({ pkg: d.pkg, address: addr, reasonCode: d.reasonCode, reasonText: d.reasonText });
  const conflicts = findPackageConflicts(S.items, d.pkg, it.id);
  const ph = d.photoId ? await photoUrl(d.photoId) : '';
  const warn = [];
  if (conflicts.length) warn.push(`⚠️ El paquete <b>#${esc(d.pkg)}</b> ya tiene un reporte en: ${conflicts.map(c => `<b>${esc(fullAddress(c))}</b> (${STATUS_LABEL[c.status].toLowerCase()}${c.sendStatus === 'sent' ? ', enviado' : ''})`).join('; ')}. Revisá la etiqueta.`);
  if (ci && !ci.validDigit) warn.push('⚠️ El dígito verificador de la cédula no coincide. Verificala con el documento.');
  if (it.status !== 'pending' && it.sendStatus === 'sent') warn.push('ℹ️ Este domicilio ya tenía un reporte <b>enviado</b>. Vas a mandar una corrección: conviene avisar que el anterior queda sin efecto.');
  setTop('Revisá antes de enviar');
  $('#view').innerHTML = `${backBtn('Corregir datos')}
    ${warn.map(w => `<div class="alert warn" style="margin-bottom:8px">${w}</div>`).join('')}
    <div class="card"><dl class="kv">
      <dt>Tipo</dt><dd>${d.type === 'delivered' ? '<span class="pill ok">✅ Entregado</span>' : '<span class="pill bad">❌ No entregado</span>'}</dd>
      <dt>Paquete</dt><dd class="mono" style="font-size:22px">#${esc(d.pkg)}</dd>
      <dt>Dirección</dt><dd>${esc(addr)}</dd>
      ${d.type === 'delivered' ? `<dt>Cédula</dt><dd class="mono" style="font-size:22px">${esc(ci.formatted)}</dd>` :
        `<dt>Motivo</dt><dd>${esc(reasonSentence(d.reasonCode, d.reasonText))}</dd><dt>Foto</dt><dd>${ph ? 'Sí' : '<span style="color:var(--bad)">Sin foto</span>'}</dd>`}
    </dl>${ph ? `<img class="photo" src="${ph}" alt="Foto" style="margin-top:10px">` : ''}</div>
    <h3>Mensaje</h3><div class="bubble" id="msgPrev">${esc(msg)}</div>
    <div class="stack" style="margin-top:16px">
      <button class="btn ${d.type === 'delivered' ? 'ok' : 'bad'} big" data-act="commit" ${conflicts.length ? 'data-conflict="1"' : ''}>Confirmar y enviar ›</button>
      <button class="btn" data-act="back">‹ Corregir datos</button></div>`;
}

async function commitReport(force) {
  const d = S.draft; const it = itemById(d.itemId); if (!it) return;
  const addr = fullAddress(it);
  if (!force && findPackageConflicts(S.items, d.pkg, it.id).length) {
    const ok = await ask('Número de paquete repetido', `El #${esc(d.pkg)} ya figura en otro reporte. ¿Seguro que es correcto?`, { ok: 'Sí, es correcto', cancel: 'Revisar' });
    if (!ok) return;
  }
  const prevPhoto = it.photoId;
  if (d.type === 'delivered') {
    const ci = parseCedula(d.cedula);
    Object.assign(it, { status: 'delivered', pkg: d.pkg, cedula: ci.formatted, reasonCode: '', reasonText: '', photoId: null });
    it.message = buildDeliveredMessage({ pkg: d.pkg, address: addr, cedula: ci.formatted });
  } else {
    Object.assign(it, { status: 'failed', pkg: d.pkg, cedula: '', reasonCode: d.reasonCode, reasonText: d.reasonCode === 'otro' ? cleanSpaces(d.reasonText) : '', photoId: d.photoId || null });
    it.message = buildFailedMessage({ pkg: d.pkg, address: addr, reasonCode: d.reasonCode, reasonText: d.reasonText });
  }
  // Minimizar datos: si cambió la foto o pasó a entregado, borrar la foto anterior
  if (prevPhoto && prevPhoto !== it.photoId) { await DB.deletePhoto(prevPhoto); S.photoUrls.delete(prevPhoto); }
  it.reportedAt = Date.now();
  it.sendStatus = 'prepared'; it.sentVia = ''; it.sendAttempts = it.sendAttempts || 0;
  await DB.putItem(it);
  S.draft = null; await saveDraft();
  await reloadItems();
  go('send', { id: it.id }, true);
}

/* ================= Envío ================= */
async function markAwaiting(it, via) {
  it.sendStatus = 'awaiting'; it.sendAttempts = (it.sendAttempts || 0) + 1; it.lastAttemptAt = Date.now(); it.lastVia = via;
  await DB.putItem(it); await DB.setMeta('awaitingId', it.id);
}

async function setSent(it, ok, via = 'manual') {
  it.sendStatus = ok ? 'sent' : 'error';
  if (ok) { it.sentAt = Date.now(); it.sentVia = via; }
  await DB.putItem(it); await DB.setMeta('awaitingId', null);
  await reloadItems();
}

function canShareFiles(file) {
  try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { return false; }
}

async function vSend() {
  const it = itemById(S.params.id);
  if (!it) return go('route', {}, true);
  const name = esc(S.settings.name || 'destinatario');
  const phone = S.settings.phone;
  const url = phone ? whatsappUrl(phone, it.message, S.settings.linkMode) : '';
  S.sendFile = null;
  if (it.photoId) {
    const blob = await DB.getPhoto(it.photoId);
    if (blob) S.sendFile = new File([blob], `paquete-${cleanPackage(it.pkg) || 'foto'}.jpg`, { type: 'image/jpeg' });
  }
  const ph = it.photoId ? await photoUrl(it.photoId) : '';
  const shareOK = S.sendFile && canShareFiles(S.sendFile);
  setTop(`Enviar a ${name}`, `${it.status === 'delivered' ? '✅ Entregado' : '❌ No entregado'} · #${esc(it.pkg)}`);
  const noPhone = !phone ? `<div class="alert warn">Configurá el número de ${name} en Ajustes para abrir el chat directamente. Mientras tanto podés usar “Compartir”.</div>` : '';
  const waBtn = (label, cls = 'wa big') => phone ? `<a class="btn ${cls}" href="${esc(url)}" data-act="wa-open" data-id="${it.id}" rel="noopener">${label}</a>` : '';
  let body;
  if (it.status === 'delivered') {
    body = `${noPhone}
      ${waBtn('🟢 Abrir WhatsApp con el mensaje')}
      <ol class="steps small muted"><li>Se abre el chat de ${name} con el texto ya escrito.</li><li>Tocá <b>Enviar ➤</b> en WhatsApp.</li><li>Volvé acá y confirmá.</li></ol>
      <div class="row"><button class="btn" data-act="copy" data-id="${it.id}">📋 Copiar texto</button>
      ${navigator.share ? `<button class="btn" data-act="share-text" data-id="${it.id}">📤 Compartir…</button>` : ''}</div>`;
  } else if (shareOK) {
    body = `${noPhone}
      <button class="btn wa big" data-act="share-photo" data-id="${it.id}">📷 Compartir foto + texto</button>
      <ol class="steps small muted"><li>En el menú de iOS elegí <b>WhatsApp</b> y luego a <b>${name}</b>.</li>
        <li>El texto también queda <b>copiado</b>: si WhatsApp no lo muestra junto a la foto, mantené apretado el campo de texto y tocá <b>Pegar</b>.</li>
        <li>Tocá <b>Enviar</b> y volvé acá a confirmar.</li></ol>
      <details class="card"><summary>Otra forma (en dos mensajes)</summary><div class="stack" style="margin-top:10px">
        ${waBtn('1) Enviar el texto (abre el chat)', 'wa')}
        <button class="btn" data-act="share-photo-only" data-id="${it.id}">2) Compartir solo la foto</button></div></details>`;
  } else {
    body = `${noPhone}
      ${it.photoId ? `<div class="alert info">Este navegador no permite compartir la foto directamente. Hacelo en dos pasos:</div>
      <ol class="steps"><li>Mantené apretada la foto de abajo → <b>Guardar en Fotos</b>.</li><li>Abrí el chat con el texto (botón verde) y adjuntá la foto con <b>+ → Fotos</b>.</li></ol>
      <img class="photo" src="${ph}" alt="Foto para guardar">` : `<div class="alert warn">Este reporte no tiene foto.</div>`}
      ${waBtn('🟢 Abrir WhatsApp con el texto')}
      <button class="btn" data-act="copy" data-id="${it.id}">📋 Copiar texto</button>`;
  }
  $('#view').innerHTML = `${backBtn('Volver')}
    <div class="bubble" style="margin-bottom:12px">${esc(it.message)}</div>
    ${it.status === 'failed' && ph && shareOK ? `<img class="photo" src="${ph}" alt="Foto" style="margin-bottom:12px;max-height:200px">` : ''}
    <div class="stack">${body}
    ${S.settings.apiEnabled && S.settings.apiUrl ? `<button class="btn primary" data-act="api-send" data-id="${it.id}">⚡ Enviar automático (API)</button>` : ''}</div>
    <div class="card" style="margin-top:18px">
      <div style="font-weight:700">¿Se envió el mensaje en WhatsApp?</div>
      <div class="small muted">Estado: ${sendPill(it) || 'sin enviar'}. La app no puede comprobarlo sola: confirmalo vos.</div>
      <div class="row" style="margin-top:10px"><button class="btn ok" data-act="confirm-sent" data-id="${it.id}">Sí, enviado</button>
      <button class="btn" data-act="confirm-fail" data-id="${it.id}">No se envió</button></div>
      <button class="btn link" data-act="later">Enviar más tarde</button>
    </div>`;
}

function copyText(text) {
  // Sin await para no perder el "gesto" del usuario en Safari
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
}

function askSentModal(it) {
  openModal(`<div data-sticky></div><h2>¿Se envió el reporte?</h2>
    <div class="bubble" style="margin-bottom:12px">${esc(it.message)}</div>
    <div class="stack"><button class="btn ok big" id="m-yes">Sí, enviado</button>
    <button class="btn" id="m-no">No se envió / hubo un error</button>
    <button class="btn link" id="m-later">Todavía no (decidir después)</button></div>`);
  $('#m-yes').onclick = async () => { closeModal(); await setSent(it, true); toast('✓ Reporte marcado como enviado'); goNextAfterSent(); };
  $('#m-no').onclick = async () => { closeModal(); await setSent(it, false); toast('Quedó como NO enviado. Podés reintentar.'); render(); };
  $('#m-later').onclick = () => closeModal();
}

function goNextAfterSent() { S.filter = 'pending'; S.query = ''; go('route', {}, true); }

async function shareFiles(it, withText) {
  if (!S.sendFile) return toast('No hay foto');
  const data = withText ? { files: [S.sendFile], text: it.message } : { files: [S.sendFile] };
  let p;
  try { p = navigator.share(data); } catch (e) { return toast('No se pudo abrir el menú de compartir'); }
  if (withText) copyText(it.message); // copia de respaldo del texto
  await markAwaiting(it, 'share');
  try { await p; askSentModal(it); }
  catch (e) {
    if (e.name === 'AbortError') { it.sendStatus = 'prepared'; await DB.putItem(it); await DB.setMeta('awaitingId', null); toast('Compartir cancelado'); }
    else toast('Error al compartir: ' + e.message);
    await reloadItems(); render();
  }
}

async function apiSend(it) {
  const s = S.settings;
  if (!navigator.onLine) return toast('Sin conexión. El reporte queda guardado como NO enviado.');
  const body = { to: s.phone, text: it.message };
  if (it.photoId) {
    const blob = await DB.getPhoto(it.photoId);
    body.imageBase64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  }
  it.sendAttempts = (it.sendAttempts || 0) + 1; it.lastAttemptAt = Date.now(); it.lastVia = 'api';
  try {
    toast('Enviando…');
    const r = await fetch(s.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiToken }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && j.messageId) { it.apiMessageId = j.messageId; await setSent(it, true, 'api'); toast('✓ Aceptado por la API de WhatsApp'); goNextAfterSent(); }
    else { await setSent(it, false); toast('La API rechazó el envío: ' + (j.error || r.status)); render(); }
  } catch (e) { await setSent(it, false); toast('Error de conexión con la API'); render(); }
}

/* ================= Importación ================= */
function newImp() {
  const sameDay = S.day && S.day.date === todayISO();
  return { target: sameDay ? 'append' : 'new', deletePrev: false, images: [], manual: [], busy: null, pasteOpen: false };
}

function impRows() {
  const all = [];
  S.imp.images.forEach((img, ii) => img.rows.forEach((r, ri) => all.push({ r, ref: ['img', ii, ri] })));
  S.imp.manual.forEach((r, ri) => all.push({ r, ref: ['man', ri] }));
  return all;
}

function vImport() {
  if (!S.imp) S.imp = newImp();
  const imp = S.imp;
  setTop('Importar lista del día', S.day ? `Jornada actual: ${fmtDate(S.day.date)} · ${S.items.length} direcciones` : 'No hay jornada cargada');
  const rows = impRows();
  const active = rows.filter(x => x.r.include);
  const existing = imp.target === 'append' ? S.items.map(i => ({ text: fullAddress(i) })) : [];
  markDuplicates(active.map(x => x.r), existing);
  rows.filter(x => !x.r.include).forEach(x => { x.r.dupRows = []; x.r.similarRows = []; x.r.dupExisting = 0; x.r.similarExisting = 0; });
  const lowN = active.filter(x => x.r.lowConf).length;
  const dupN = active.filter(x => x.r.dupRows?.length || x.r.dupExisting).length;
  const st = S.day ? dayStats(S.items) : null;
  $('#view').innerHTML = `
    ${S.day ? `<div class="card"><div style="font-weight:700">¿Dónde se cargan?</div>
      <label class="reason ${imp.target === 'new' ? 'sel' : ''}" style="margin-top:8px"><input type="radio" name="tgt" value="new" ${imp.target === 'new' ? 'checked' : ''}>Nueva jornada (${fmtDate(todayISO())})</label>
      <label class="reason ${imp.target === 'append' ? 'sel' : ''}" style="margin-top:8px"><input type="radio" name="tgt" value="append" ${imp.target === 'append' ? 'checked' : ''}>Agregar a la jornada del ${fmtDate(S.day.date)}</label>
      ${imp.target === 'new' ? `<label class="reason" style="margin-top:8px"><input type="checkbox" id="delPrev" ${imp.deletePrev ? 'checked' : ''}>Borrar la jornada anterior (${S.items.length} direcciones${st.unsent ? `, <b style="color:var(--bad)">&nbsp;${st.unsent} reportes sin enviar</b>` : ''})</label>
        <div class="small muted" style="margin-top:6px">Si no la borrás, queda en Historial y no se mezcla con la nueva.</div>` : ''}
    </div>` : ''}
    <h2>1. Agregar capturas</h2>
    <div class="stack">
      <label class="btn primary big" for="imp-gal">🖼️ Elegir capturas</label>
      <div class="row"><label class="btn" for="imp-cam">📷 Sacar foto</label><button class="btn" data-act="imp-paste">⌨️ Pegar texto</button></div>
      <input type="file" id="imp-gal" class="hidden-input" accept="image/*" multiple>
      <input type="file" id="imp-cam" class="hidden-input" accept="image/*" capture="environment">
      <div class="small muted">El reconocimiento se hace en este teléfono: las capturas no se suben a ningún servidor. La primera vez descarga el motor de lectura (~15&nbsp;MB).</div>
    </div>
    ${imp.pasteOpen ? `<div class="card" style="margin-top:12px"><div style="font-weight:700">Pegar o escribir direcciones</div>
      <div class="small muted">Una por línea. Truco: en Fotos abrí la captura, mantené apretado el texto (Texto en vivo) → Seleccionar todo → Copiar, y pegalo acá.</div>
      <label class="field"><textarea id="paste" rows="6" placeholder="Zum Felde 2190, casa&#10;Zum Felde 2190, apto 2"></textarea></label>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="imp-paste-add">Agregar</button><button class="btn" data-act="imp-paste-close">Cerrar</button></div></div>` : ''}
    ${imp.busy ? `<div class="card" style="margin-top:12px"><span class="spinner"></span> ${esc(imp.busy)}</div>` : ''}
    ${imp.images.map((img, ii) => `<div class="card" style="margin-top:12px">
      <div class="row" style="align-items:center"><div><b>Captura ${ii + 1}</b> <span class="muted small">${esc(img.name)} · ${img.rows.length} filas</span></div>
      <button class="btn small danger-outline" style="flex:none" data-act="imp-rm-img" data-i="${ii}">Quitar</button></div>
      ${img.analysis.columns.length > 1 ? `<div class="small muted" style="margin:8px 0 6px">Qué es cada columna (tocá para cambiar):</div>
      <div class="colchips">${img.analysis.columns.filter(c => c.filled).map(c => { const role = img.roles[c.index] || 'none'; return `<button class="colchip role-${role}" data-act="imp-col" data-i="${ii}" data-c="${c.index}"><b>${esc(ROLE_LABEL[role])}</b> ${esc(c.sample || '—')}</button>`; }).join('')}</div>` : ''}
      ${img.error ? `<div class="alert bad" style="margin-top:8px">${esc(img.error)}</div>` : ''}
    </div>`).join('')}
    ${rows.length ? `<h2>2. Revisar (${active.length} direcciones)</h2>
      ${lowN ? `<div class="alert warn" style="margin-bottom:8px">⚠️ ${lowN} con lectura dudosa: comparalas con el recorte y corregilas.</div>` : ''}
      ${dupN ? `<div class="alert info" style="margin-bottom:8px">Hay ${dupN} posibles duplicados. No se borran solos: pueden ser paquetes distintos. Desmarcá los que sobren.</div>` : ''}
      <div class="stack" id="revList">${rows.map(({ r, ref }) => revRow(r, ref, rows)).join('')}</div>
      <button class="btn link" data-act="imp-add-row">＋ Agregar dirección a mano</button>
      <div class="stack" style="margin-top:12px;position:sticky;bottom:calc(var(--tabh) + var(--safe-b) + 8px)">
        <button class="btn ok big" data-act="imp-commit" ${active.length ? '' : 'disabled'}>Importar ${active.length} direcciones</button></div>
      <button class="btn link danger-outline" data-act="imp-reset">Descartar todo</button>` :
      `<button class="btn link" data-act="imp-add-row">＋ Agregar dirección a mano</button>`}`;
  document.querySelectorAll('input[name=tgt]').forEach(r => r.addEventListener('change', () => { imp.target = r.value; vImport(); }));
  $('#delPrev')?.addEventListener('change', e => { imp.deletePrev = e.target.checked; });
  for (const id of ['imp-gal', 'imp-cam']) $('#' + id).addEventListener('change', e => { const fs = [...(e.target.files || [])]; e.target.value = ''; processImages(fs); });
  document.querySelectorAll('[data-rowtext]').forEach(inp => inp.addEventListener('change', e => {
    const r = refRow(JSON.parse(e.target.dataset.rowtext)); r.text = cleanSpaces(e.target.value); r.edited = true;
    r.lowConf = false; r.reasons = /\d/.test(r.text) ? [] : ['Sin número de puerta']; vImportKeepScroll();
  }));
  document.querySelectorAll('[data-rowfield]').forEach(inp => inp.addEventListener('change', e => {
    const { ref, f } = JSON.parse(e.target.dataset.rowfield);
    const r = refRow(ref);
    r[f] = f === 'orderNo' ? cleanPackage(e.target.value) : cleanSpaces(e.target.value);
    if (f === 'orderNo') r.reasons = (r.reasons || []).filter(x => !/pedido/.test(x));
    r.lowConf = (r.reasons || []).length > 0;
    vImportKeepScroll();
  }));
  document.querySelectorAll('[data-rowinc]').forEach(cb => cb.addEventListener('change', e => { refRow(JSON.parse(e.target.dataset.rowinc)).include = e.target.checked; vImportKeepScroll(); }));
}

function vImportKeepScroll() { const y = window.scrollY; vImport(); window.scrollTo(0, y); }

function refRow(ref) { return ref[0] === 'img' ? S.imp.images[ref[1]].rows[ref[2]] : S.imp.manual[ref[1]]; }
function rowNumber(rows, r) { return rows.findIndex(x => x.r === r) + 1; }

function revRow(r, ref, rows) {
  const flags = [];
  (r.reasons || []).forEach(x => flags.push(`<span class="pill warn">${esc(x)}</span>`));
  if (r.dupRows?.length) {
    const actives = rows.filter(x => x.r.include);
    flags.push(`<span class="pill warn">Igual a fila ${r.dupRows.map(j => rowNumber(rows, actives[j].r)).join(', ')}</span>`);
  }
  if (r.dupExisting) flags.push(`<span class="pill warn">Ya está en la jornada</span>`);
  if (r.similarRows?.length || r.similarExisting) flags.push(`<span class="pill gray">Misma puerta, otra referencia</span>`);
  const sp = splitAddress(r.text);
  const fld = f => esc(JSON.stringify({ ref, f }));
  return `<div class="rev ${r.lowConf && r.include ? 'low' : ''} ${r.include ? '' : 'off'}">
    ${r.crop ? `<img src="${r.crop}" alt="Recorte">` : ''}
    <div class="top"><input type="checkbox" data-rowinc='${JSON.stringify(ref)}' ${r.include ? 'checked' : ''} aria-label="Incluir">
    <span class="muted small" style="width:22px">${rowNumber(rows, r)}</span>
    <span class="hash">#</span><input type="text" class="f-order mono" value="${esc(r.orderNo || '')}" data-rowfield="${fld('orderNo')}" inputmode="numeric" autocomplete="off" placeholder="Pedido" aria-label="Número de pedido">
    <input type="text" class="f-co" value="${esc(r.company || '')}" data-rowfield="${fld('company')}" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Empresa" aria-label="Empresa"></div>
    <input type="text" class="f-addr" value="${esc(r.text)}" data-rowtext='${JSON.stringify(ref)}' autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Dirección" aria-label="Dirección">
    <input type="text" class="f-zone" value="${esc(r.zone || '')}" data-rowfield="${fld('zone')}" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Barrio (ayuda a ubicarla en el mapa)" aria-label="Barrio">
    ${flags.length || sp.refs ? `<div class="flags">${sp.refs ? `<span class="ref small">${esc(sp.refs)}</span>` : ''}${flags.join('')}</div>` : ''}
  </div>`;
}

async function processImages(files) {
  if (!files.length) return;
  const { recognizeImage, cropRow } = await import('./ocr.js');
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    const label = `Leyendo captura ${k + 1} de ${files.length}…`;
    S.imp.busy = label; vImport();
    try {
      const res = await recognizeImage(f, m => {
        const el = document.querySelector('#view .spinner')?.parentElement;
        if (el) el.innerHTML = `<span class="spinner"></span> ${esc(label)} ${esc(traducir(m.status))} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`;
      });
      const img = { name: f.name || 'foto', analysis: res.analysis, canvas: res.canvas, roles: { ...res.analysis.roles }, rows: [] };
      img.rows = makeRows(img, cropRow);
      if (!img.rows.length) img.error = 'No se encontraron direcciones en esta imagen. Probá con una captura más nítida, elegí otras columnas o usá “Pegar texto”.';
      S.imp.images.push(img);
    } catch (e) {
      console.warn('OCR', e.message);
      toast(e.message || 'Error al leer la imagen', 5000);
    }
  }
  S.imp.busy = null; vImport();
}

function traducir(s = '') {
  return ({ 'loading tesseract core': 'cargando motor', 'initializing tesseract': 'iniciando', 'loading language traineddata': 'descargando idioma', 'initializing api': 'preparando', 'recognizing text': 'reconociendo' })[s] || '';
}

function makeRows(img, cropRow) {
  return buildRows(img.analysis, img.roles).map(r => ({ ...r, original: r.text, include: true, crop: cropRow ? cropRow(img.canvas, r) : '' }));
}

async function importCommit() {
  const imp = S.imp;
  const rows = impRows().map(x => x.r).filter(r => r.include && cleanSpaces(r.text));
  if (!rows.length) return;
  if (imp.target === 'new' && imp.deletePrev && S.day) {
    const st = dayStats(S.items);
    if (st.unsent && !(await ask('Hay reportes sin enviar', `La jornada anterior tiene ${st.unsent} reportes sin enviar. Si la borrás, se pierden.`, { ok: 'Borrar igual', cancel: 'Cancelar', danger: true }))) return;
  }
  let day = S.day;
  if (imp.target === 'new' || !day) {
    if (imp.deletePrev && S.day) await DB.deleteDay(S.day.id);
    day = { id: DB.uid(), date: todayISO(), createdAt: Date.now() };
    await DB.putDay(day); await DB.setMeta('activeDayId', day.id);
  }
  const start = imp.target === 'append' && S.day ? S.items.length : 0;
  const items = rows.map((r, i) => {
    const sp = splitAddress(r.text);
    return {
      id: DB.uid(), dayId: day.id, order: start + i,
      original: r.original || r.text, address: sp.address, refs: sp.refs, crop: r.crop || '',
      orderNo: cleanPackage(r.orderNo || ''), company: cleanSpaces(r.company || ''), zone: cleanSpaces(r.zone || ''),
      lat: null, lng: null, geo: null, routeOrder: null,
      ocrConf: r.conf ?? null, status: 'pending', pkg: '', cedula: '', reasonCode: '', reasonText: '',
      photoId: null, reportedAt: null, sendStatus: 'none', sendAttempts: 0, message: '', createdAt: Date.now()
    };
  });
  await DB.putItems(items);
  S.day = day; S.imp = null; await reloadItems();
  try { navigator.storage?.persist?.(); } catch {}
  toast(`✓ ${items.length} direcciones importadas`);
  S.filter = 'pending'; S.query = '';
  go('route', {}, true);
}

/* ================= Historial ================= */
async function vHistory() {
  const st = dayStats(S.items);
  const reports = S.items.filter(i => i.status !== 'pending').sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0));
  const unsent = reports.filter(i => i.sendStatus !== 'sent');
  const days = await DB.listDays();
  setTop('Historial', S.day ? `Jornada ${fmtDate(S.day.date)}` : '');
  const repLi = it => `<li><button class="addr ${it.status}" data-act="open" data-id="${it.id}"><span class="dot ${it.status}"></span>
    <span class="main"><div class="street"><span class="mono">#${esc(it.pkg)}</span> · ${esc(it.address)}</div>
    <div class="meta">${it.refs ? `<span class="ref">${esc(it.refs)}</span>` : ''}${statusPill(it)} ${sendPill(it)} <span>${fmtTime(it.reportedAt)}</span>
    ${it.status === 'delivered' ? `<span class="mono">CI ${esc(it.cedula)}</span>` : `<span>${esc(REASONS.find(r => r.code === it.reasonCode)?.label || '')}</span>${it.photoId ? ' 📷' : ''}`}</div></span>
    <span class="chev">›</span></button></li>`;
  $('#view').innerHTML = S.day ? `
    <div class="stats">
      <div class="stat"><b>${st.total}</b><span>Importadas</span></div>
      <div class="stat"><b>${st.pending}</b><span>Pendientes</span></div>
      <div class="stat"><b style="color:var(--ok)">${st.delivered}</b><span>Entregadas</span></div>
      <div class="stat"><b style="color:var(--bad)">${st.failed}</b><span>No entregadas</span></div>
      <div class="stat" style="grid-column:span 2"><b style="color:${st.unsent ? 'var(--warn)' : 'inherit'}">${st.unsent}</b><span>Reportes pendientes de envío o confirmación</span></div>
    </div>
    ${unsent.length ? `<h2>⚠️ Sin enviar o sin confirmar</h2><ul class="list">${unsent.map(repLi).join('')}</ul>` : ''}
    <h2>Reportes (${reports.length})</h2>
    ${reports.length ? `<ul class="list">${reports.map(repLi).join('')}</ul>` : '<p class="muted">Todavía no hay reportes.</p>'}
  ` : '<p class="muted">No hay jornada activa.</p>';
  $('#view').insertAdjacentHTML('beforeend', `
    <h2>Jornadas guardadas</h2>
    <ul class="list">${days.map(d => `<li class="card row" style="align-items:center">
      <div><b>${fmtDate(d.date)}</b> ${d.id === S.day?.id ? '<span class="pill">Activa</span>' : ''}<div class="small muted">Creada ${fmtDateTime(d.createdAt)}</div></div>
      <div style="flex:none;display:flex;gap:6px">${d.id !== S.day?.id ? `<button class="btn small" data-act="day-open" data-id="${d.id}">Abrir</button>` : ''}
      <button class="btn small danger-outline" data-act="day-del" data-id="${d.id}">Borrar</button></div></li>`).join('') || '<li class="muted">No hay jornadas.</li>'}</ul>
    <p class="small muted">Los datos (direcciones, cédulas y fotos) se guardan solo en este iPhone, dentro de la app. Se borran automáticamente las jornadas de más de ${S.settings.retentionDays} días (cambialo en Ajustes).</p>`);
}

/* ================= Ajustes ================= */
async function vSettings() {
  const s = S.settings;
  let est = '';
  try { const e = await navigator.storage?.estimate?.(); if (e) est = `${(e.usage / 1048576).toFixed(1)} MB usados`; } catch {}
  let persisted = false; try { persisted = await navigator.storage?.persisted?.(); } catch {}
  setTop('Ajustes');
  $('#view').innerHTML = `
    <h2>WhatsApp de destino</h2>
    <div class="card">
      <label class="field" style="margin-top:0"><span>Nombre</span><input id="s-name" value="${esc(s.name)}" autocomplete="off"></label>
      <label class="field"><span>Número de WhatsApp</span><input id="s-phone" inputmode="tel" value="${esc(s.phone)}" placeholder="099 123 456" autocomplete="off">
        <div class="hint" id="s-phone-hint">${s.phone ? 'Guardado como +' + esc(s.phone) : 'Celular uruguayo (099…) o con código de país.'}</div></label>
      <div class="field"><span>Forma de abrir WhatsApp</span>
        <label class="reason ${s.linkMode === 'app' ? 'sel' : ''}"><input type="radio" name="lm" value="app" ${s.linkMode === 'app' ? 'checked' : ''}>Directo a la app (recomendado)</label>
        <label class="reason ${s.linkMode === 'web' ? 'sel' : ''}" style="margin-top:8px"><input type="radio" name="lm" value="web" ${s.linkMode === 'web' ? 'checked' : ''}>Enlace wa.me (si el anterior no funciona)</label></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="s-save">Guardar</button>
      ${s.phone ? `<a class="btn" href="${esc(whatsappUrl(s.phone, 'Prueba de la app de reparto', s.linkMode))}">Probar</a>` : ''}</div>
    </div>
    <h2>Ruta y mapa</h2>
    <div class="card">
      <label class="field" style="margin-top:0"><span>Ciudad (para buscar las direcciones)</span><input id="s-city" value="${esc(s.city)}" autocomplete="off"></label>
      <div class="field"><span>¿Desde dónde arranca la ruta?</span>
        ${[['gps', 'Desde donde estoy (ubicación del teléfono)'], ['address', 'Desde una dirección fija'], ['none', 'Desde la primera parada']].map(([v, l]) =>
          `<label class="reason ${s.startMode === v ? 'sel' : ''}" style="margin-top:8px"><input type="radio" name="sm" value="${v}" ${s.startMode === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
      <label class="field"><span>Dirección de partida${s.startMode === 'gps' ? ' (se usa si no hay ubicación)' : ''}</span><input id="s-start" value="${esc(s.startAddress)}" placeholder="Ej: Av. Italia 4100" autocomplete="off"></label>
      <p class="small muted">Al tocar “Armar ruta” se envían calle, número y barrio a OpenStreetMap para ubicarlas y calcular el recorrido. ${s.mapConsent ? 'Ya lo aceptaste.' : ''}</p>
      <button class="btn primary" data-act="s-save" style="margin-top:6px">Guardar</button>
    </div>
    <h2>Privacidad y datos</h2>
    <div class="card stack">
      <label class="field" style="margin-top:0"><span>Borrar jornadas automáticamente después de</span>
        <select id="s-ret">${[1, 3, 7, 14, 30].map(n => `<option value="${n}" ${s.retentionDays === n ? 'selected' : ''}>${n} día${n > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <div class="small muted">${est}${persisted ? ' · almacenamiento protegido ✓' : ' · iOS podría borrar los datos si no usás la app por varias semanas.'}</div>
      <button class="btn danger-outline" data-act="wipe">🗑️ Borrar TODOS los datos</button>
    </div>
    <h2>Avanzado</h2>
    <details class="card" ${s.apiEnabled ? 'open' : ''}><summary>Envío automático con WhatsApp Cloud API (opcional)</summary>
      <p class="small muted">Requiere un servidor propio y una cuenta de WhatsApp Business Platform (ver README). Sin eso, dejalo apagado.</p>
      <label class="reason"><input type="checkbox" id="s-api" ${s.apiEnabled ? 'checked' : ''}>Activar botón “Enviar automático”</label>
      <label class="field"><span>URL del servidor</span><input id="s-apiurl" value="${esc(s.apiUrl)}" placeholder="https://mi-worker.ejemplo.workers.dev/send" autocomplete="off"></label>
      <label class="field"><span>Clave de la app (no es el token de Meta)</span><input id="s-apitok" type="password" value="${esc(s.apiToken)}" autocomplete="off"></label>
      <button class="btn" data-act="s-save" style="margin-top:10px">Guardar</button>
    </details>
    <div class="stack" style="margin-top:16px">
      <button class="btn" data-act="tab" data-tab="help">❓ Ayuda e instalación</button>
      <button class="btn" data-act="demo">🧪 Crear jornada de prueba (datos ficticios)</button>
    </div>
    <p class="small muted center">Versión ${APP_VERSION}</p>`;
  $('#s-phone').addEventListener('input', e => {
    const n = normalizePhone(e.target.value);
    $('#s-phone-hint').textContent = e.target.value ? (isValidPhone(n) ? 'Se usará +' + n : 'Número incompleto') : '';
  });
}

async function saveSettingsFromForm() {
  const s = S.settings;
  s.name = cleanSpaces($('#s-name').value) || 'Tía';
  const ph = normalizePhone($('#s-phone').value);
  if ($('#s-phone').value && !isValidPhone(ph)) return toast('El número no parece válido');
  s.phone = ph;
  s.linkMode = document.querySelector('input[name=lm]:checked')?.value || 'app';
  s.retentionDays = Number($('#s-ret').value);
  s.city = cleanSpaces($('#s-city').value) || 'Montevideo';
  s.startMode = document.querySelector('input[name=sm]:checked')?.value || 'gps';
  s.startAddress = cleanSpaces($('#s-start').value);
  if (s.startMode === 'address' && !s.startAddress) return toast('Escribí la dirección de partida');
  s.apiEnabled = $('#s-api').checked;
  s.apiUrl = $('#s-apiurl').value.trim();
  s.apiToken = $('#s-apitok').value.trim();
  if (s.apiEnabled && !/^https:\/\//.test(s.apiUrl)) return toast('La URL del servidor debe empezar con https://');
  await saveSettings(); toast('✓ Ajustes guardados'); vSettings();
}

/* ================= Ayuda ================= */
function vHelp() {
  setTop('Ayuda');
  $('#view').innerHTML = `${backBtn()}
  <div class="card stack small">
    <h3>Instalar en el iPhone</h3>
    <ol class="steps"><li>Abrí la dirección de la app en <b>Safari</b>.</li><li>Tocá <b>Compartir</b> (cuadrado con flecha) → <b>Agregar a pantalla de inicio</b>.</li><li>Abrila siempre desde el ícono “Reparto”.</li></ol>
    <h3>Uso diario</h3>
    <ol class="steps"><li><b>Importar</b> → elegí las capturas de la lista → revisá pedido, empresa y dirección (las dudosas quedan en amarillo) → Importar.</li>
    <li>En <b>Mapa</b> tocá <b>Armar ruta optimizada</b>: las paradas quedan numeradas en el orden más corto.</li>
    <li>En <b>Reparto</b> seguí el orden (o buscá por calle, pedido o empresa) y tocá la parada. <b>Ir</b> abre Google Maps o Waze.</li>
    <li><b>Entregado</b>: escribí la cédula y tocá Entregado → revisá → Confirmar → <b>Abrir WhatsApp</b> → Enviar.</li>
    <li><b>No entregado</b>: número, motivo y foto → Revisar → Confirmar → <b>Compartir foto + texto</b> → WhatsApp → tu tía → Enviar.</li>
    <li>Volvé a la app y tocá <b>Sí, enviado</b>. Si no, el reporte queda en “Sin enviar”.</li></ol>
    <h3>Qué hace y qué no hace</h3>
    <ul class="steps"><li>WhatsApp normal no permite que una app envíe mensajes sola: siempre vas a tocar “Enviar” vos.</li>
    <li>El número de pedido sale de la lista: verificalo con la etiqueta antes de enviar.</li>
    <li>Las capturas se leen en el teléfono; no se suben a ningún servidor.</li>
    <li>Para el mapa, calle, número y barrio se envían a OpenStreetMap (solo cuando tocás “Armar ruta”).</li>
    <li>Los datos quedan solo en este iPhone. Si borrás los datos de Safari o la app, se pierden.</li></ul>
  </div>`;
}

/* ================= Acciones (delegación) ================= */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const it = id ? itemById(id) : null;
  switch (act) {
    case 'back': history.back(); break;
    case 'tab': go(el.dataset.tab, {}, el.dataset.tab !== 'help'); break;
    case 'filter': S.filter = el.dataset.f; S.query = ''; vRoute(); break;
    case 'open': go('detail', { id }); break;
    case 'start': startDraft(id, el.dataset.type, el.dataset.correct === '1'); break;
    case 'quick-deliver': quickDeliver(id); break;
    case 'route-go': go('map', {}, true); buildRoute(); break;
    case 'route-build': buildRoute(); break;
    case 'map-pick': S.pick = id; S.mapSel = null; go('map', {}, S.view === 'map'); toast('Tocá en el mapa dónde queda'); break;
    case 'map-pick-cancel': S.pick = null; vMap(); break;
    case 'map-sel-close': S.mapSel = null; renderMapSel(); break;
    case 'pkg-kbd': S.draft.pkgText = !S.draft.pkgText; $('#f-pkg').setAttribute('inputmode', S.draft.pkgText ? 'text' : 'numeric'); $('#f-pkg').blur(); $('#f-pkg').focus(); el.textContent = S.draft.pkgText ? 'Usar teclado numérico' : '¿Tiene letras?'; break;
    case 'review': review(); break;
    case 'commit': commitReport(false); break;
    case 'goto-send': go('send', { id }); break;
    case 'wa-open':
      // No se previene la navegación: el enlace abre WhatsApp. Solo registramos el intento.
      if (it) markAwaiting(it, 'link');
      break;
    case 'copy': if (it) { copyText(it.message).then(ok => toast(ok === false ? 'No se pudo copiar' : '📋 Texto copiado')); } break;
    case 'share-text': if (it) {
      let p; try { p = navigator.share({ text: it.message }); } catch { return toast('No se pudo compartir'); }
      markAwaiting(it, 'share');
      p.then(() => askSentModal(it), async err => { if (err.name === 'AbortError') { it.sendStatus = 'prepared'; await DB.putItem(it); await DB.setMeta('awaitingId', null); } });
    } break;
    case 'share-photo': if (it) shareFiles(it, true); break;
    case 'share-photo-only': if (it) shareFiles(it, false); break;
    case 'api-send': if (it) apiSend(it); break;
    case 'confirm-sent': if (it) { await setSent(it, true); toast('✓ Reporte marcado como enviado'); goNextAfterSent(); } break;
    case 'confirm-fail': if (it) { await setSent(it, false); toast('Quedó como NO enviado. Podés reintentar.'); vSend(); } break;
    case 'later': await DB.setMeta('awaitingId', null); toast('Queda en “Sin enviar”'); goNextAfterSent(); break;
    case 'mark-sent': if (it && await ask('Marcar como enviado', '¿Confirmás que este reporte ya se envió por WhatsApp?', { ok: 'Sí, ya se envió' })) { await setSent(it, true); render(); } break;
    case 'reset': if (it && await ask('Volver a pendiente', `Se borra el reporte de esta dirección${it.photoId ? ' y su foto' : ''}.${it.sendStatus === 'sent' ? ' <b>El mensaje ya se había enviado</b>: avisá que queda sin efecto.' : ''}`, { ok: 'Volver a pendiente', danger: true })) {
      if (it.photoId) { await DB.deletePhoto(it.photoId); S.photoUrls.delete(it.photoId); }
      Object.assign(it, { status: 'pending', pkg: '', cedula: '', reasonCode: '', reasonText: '', photoId: null, reportedAt: null, sendStatus: 'none', message: '', sentVia: '' });
      await DB.putItem(it); await reloadItems(); render();
    } break;
    case 'edit-addr': if (it) {
      openModal(`<h2>Corregir datos</h2><div class="small muted">Original: “${esc(it.original)}”</div>
        <div class="row"><label class="field"><span>Pedido</span><input id="e-order" class="mono" inputmode="numeric" value="${esc(it.orderNo || '')}" autocomplete="off"></label>
        <label class="field"><span>Empresa</span><input id="e-co" value="${esc(it.company || '')}" autocomplete="off" autocorrect="off"></label></div>
        <label class="field"><span>Calle y número</span><input id="e-addr" value="${esc(it.address)}" autocomplete="off" autocorrect="off"></label>
        <label class="field"><span>Referencias (casa, apto, torre…)</span><input id="e-refs" value="${esc(it.refs)}" autocomplete="off" autocorrect="off"></label>
        <label class="field"><span>Barrio</span><input id="e-zone" value="${esc(it.zone || '')}" autocomplete="off" autocorrect="off"></label>
        <div class="stack" style="margin-top:14px"><button class="btn primary" id="e-ok">Guardar</button><button class="btn" id="e-no">Cancelar</button>
        ${it.status === 'pending' ? `<button class="btn danger-outline" id="e-del">Eliminar esta dirección</button>` : ''}</div>`);
      $('#e-no').onclick = closeModal;
      $('#e-ok').onclick = async () => {
        const a = cleanSpaces($('#e-addr').value); if (!a) return toast('La dirección no puede quedar vacía');
        const zone = cleanSpaces($('#e-zone').value);
        // Si cambió la calle o el barrio, hay que volver a ubicarla en el mapa (salvo que se haya marcado a mano)
        if ((a !== it.address || zone !== (it.zone || '')) && it.geo !== 'manual') Object.assign(it, { lat: null, lng: null, geo: null });
        it.address = a; it.refs = cleanSpaces($('#e-refs').value); it.zone = zone;
        it.orderNo = cleanPackage($('#e-order').value); it.company = cleanSpaces($('#e-co').value);
        if (it.status !== 'pending') {
          it.message = it.status === 'delivered' ? buildDeliveredMessage({ pkg: it.pkg, address: fullAddress(it), cedula: it.cedula })
            : buildFailedMessage({ pkg: it.pkg, address: fullAddress(it), reasonCode: it.reasonCode, reasonText: it.reasonText });
          if (it.sendStatus === 'sent') toast('Ojo: el mensaje ya enviado tenía la dirección anterior', 4000);
        }
        await DB.putItem(it); closeModal(); await reloadItems(); render();
      };
      $('#e-del') && ($('#e-del').onclick = async () => { closeModal(); if (await ask('Eliminar dirección', esc(fullAddress(it)), { ok: 'Eliminar', danger: true })) { await DB.deleteItem(it.id); await reloadItems(); history.back(); } });
    } break;
    // Importación
    case 'imp-paste': S.imp.pasteOpen = true; vImport(); setTimeout(() => $('#paste')?.focus(), 100); break;
    case 'imp-paste-close': S.imp.pasteOpen = false; vImport(); break;
    case 'imp-paste-add': {
      const rs = rowsFromText($('#paste').value).map(r => ({ ...r, original: r.text, include: true }));
      S.imp.manual.push(...rs); S.imp.pasteOpen = false; vImport(); toast(`${rs.length} direcciones agregadas para revisar`);
    } break;
    case 'imp-add-row': S.imp.manual.push({ text: '', original: '', include: true, conf: 100, lowConf: true, reasons: ['Completar'] }); vImport();
      setTimeout(() => { const ins = document.querySelectorAll('[data-rowtext]'); ins[ins.length - 1]?.focus(); }, 50); break;
    case 'imp-rm-img': S.imp.images.splice(Number(el.dataset.i), 1); vImport(); break;
    case 'imp-col': {
      const img = S.imp.images[Number(el.dataset.i)], c = Number(el.dataset.c);
      const cur = img.roles[c] || 'none';
      const nextRole = ROLE_CYCLE[(ROLE_CYCLE.indexOf(cur) + 1) % ROLE_CYCLE.length];
      // Pedido, empresa y barrio: una sola columna cada uno (la dirección puede sumar varias)
      if (nextRole !== 'address' && nextRole !== 'none') for (const k in img.roles) if (img.roles[k] === nextRole) img.roles[k] = 'none';
      img.roles[c] = nextRole;
      const { cropRow } = await import('./ocr.js');
      img.rows = Object.values(img.roles).includes('address') ? makeRows(img, cropRow) : [];
      vImportKeepScroll();
    } break;
    case 'imp-commit': importCommit(); break;
    case 'imp-reset': if (await ask('Descartar', '¿Descartar las capturas y direcciones sin importar?', { ok: 'Descartar', danger: true })) { S.imp = newImp(); vImport(); } break;
    // Historial / ajustes
    case 'day-open': await DB.setMeta('activeDayId', id); await loadActiveDay(); toast('Jornada abierta'); go('route', {}, true); break;
    case 'day-del': {
      const d = await DB.getDay(id); if (!d) break;
      const its = await DB.itemsOfDay(id); const un = dayStats(its).unsent;
      if (await ask('Borrar jornada', `Jornada del ${fmtDate(d.date)}: ${its.length} direcciones, reportes y fotos.${un ? ` <b>${un} reportes sin enviar.</b>` : ''} No se puede deshacer.`, { ok: 'Borrar', danger: true })) {
        await DB.deleteDay(id);
        if (S.day?.id === id) { await DB.setMeta('activeDayId', null); S.day = null; S.items = []; }
        toast('Jornada borrada'); vHistory();
      }
    } break;
    case 'wipe': if (await ask('Borrar todo', 'Se borran todas las jornadas, reportes y fotos de este teléfono. Los ajustes se mantienen.', { ok: 'Borrar todo', danger: true })) {
      await DB.deleteEverything(); await DB.setMeta('activeDayId', null); await DB.setMeta('draft', null); await DB.setMeta('awaitingId', null); await DB.setMeta('geocache', {});
      S.day = null; S.items = []; S.draft = null; toast('Datos borrados'); vSettings();
    } break;
    case 's-save': saveSettingsFromForm(); break;
    case 'demo': await createDemo(); break;
  }
});

async function createDemo() {
  if (S.day && !(await ask('Jornada de prueba', 'Se crea una jornada nueva con direcciones ficticias. La actual queda en Historial.', { ok: 'Crear' }))) return;
  // Calles reales de Montevideo con números de ejemplo (para probar el mapa); pedidos y empresas inventados.
  const demo = [
    ['9001', 'Nova', 'Malvín', 'Zum Felde 2190, casa'], ['9002', 'Nova', 'Malvín', 'Zum Felde 2190, apto 2'],
    ['9003', 'Resty', 'La Blanqueada', 'Av. 8 de Octubre 3456'], ['9004', 'Garden', 'Pocitos', 'Ellauri 350, apto 501, torre B'],
    ['9005', 'Garden', 'Unión', 'José Batlle y Ordóñez 3200, unidad habitacional, bloque 3'], ['9006', 'Oxi', 'Carrasco', 'Camino Carrasco 7012'],
    ['9007', 'Hierba', 'Pocitos', 'Libertad 2741 piso 4'], ['9008', 'Wisher', 'Tres Cruces', 'Bv. Artigas 1100'],
    ['9009', 'Aquora', 'Buceo', 'Av. Rivera 3800'], ['9010', 'Flexiva', 'Punta Carretas', 'Bulevar España 2650']
  ];
  const day = { id: DB.uid(), date: todayISO(), createdAt: Date.now(), demo: true };
  await DB.putDay(day); await DB.setMeta('activeDayId', day.id);
  await DB.putItems(demo.map(([orderNo, company, zone, t], i) => { const sp = splitAddress(t); return { id: DB.uid(), dayId: day.id, order: i, original: t, address: sp.address, refs: sp.refs, crop: '', orderNo, company, zone, lat: null, lng: null, geo: null, routeOrder: null, status: 'pending', pkg: '', cedula: '', reasonCode: '', reasonText: '', photoId: null, reportedAt: null, sendStatus: 'none', sendAttempts: 0, message: '', createdAt: Date.now() }; }));
  S.day = day; await reloadItems(); toast('Jornada de prueba creada'); go('route', {}, true);
}

/* ================= Al volver de WhatsApp ================= */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  const aid = await DB.getMeta('awaitingId');
  if (!aid) return;
  const it = itemById(aid) || await DB.getItem(aid);
  if (it && it.sendStatus === 'awaiting' && $('#modal').hidden) { await reloadItems(); askSentModal(itemById(aid) || it); }
});
window.addEventListener('online', () => toast('Conexión recuperada'));
window.addEventListener('offline', () => toast('Sin conexión: podés seguir reportando; WhatsApp enviará cuando vuelva la señal.', 4000));

/* ================= Inicio ================= */
async function init() {
  try {
    await loadSettings();
    await loadActiveDay();
    const purged = await purgeOld();
    if (purged) toast(`Se borraron ${purged} jornadas antiguas`);
    S.draft = await DB.getMeta('draft');
    if (S.draft && !itemById(S.draft.itemId)) { S.draft = null; await saveDraft(); }
    history.replaceState({ view: 'route', params: {} }, '');
    S.view = 'route';
    // Si iOS recargó la app mientras se sacaba la foto, retomamos el formulario.
    if (S.draft) {
      history.pushState({ view: S.draft.type === 'delivered' ? 'deliver' : 'fail', params: { id: S.draft.itemId } }, '');
      S.view = S.draft.type === 'delivered' ? 'deliver' : 'fail'; S.params = { id: S.draft.itemId };
      setTimeout(() => toast('Se recuperó el reporte que estabas completando'), 300);
    }
    render();
    const aid = await DB.getMeta('awaitingId');
    if (aid && itemById(aid)?.sendStatus === 'awaiting') askSentModal(itemById(aid));
  } catch (e) {
    $('#view').innerHTML = `<div class="alert bad">No se pudo abrir el almacenamiento local: ${esc(e.message)}. Si usás Safari en modo privado, abrila en modo normal.</div>`;
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
init();

// Exponer para pruebas automáticas
window.__app = { S, DB, render, go };
