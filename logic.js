// logic.js — Funciones puras (sin DOM). Se usan en la app y en los tests (Node).

/* ---------------- Texto y normalización ---------------- */

export function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

export function cleanSpaces(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,(?=\S)/g, ', ')
    .replace(/^[\s,.;:|_\-–—]+|[\s,;:|_\-–—]+$/g, '')
    .trim();
}

/* ---------------- Direcciones y referencias ---------------- */

// Palabras que indican una referencia adicional dentro del domicilio.
const REF_WORDS = [
  'casa', 'apto', 'apt', 'ap', 'apartamento', 'dpto', 'depto', 'departamento',
  'unidad habitacional', 'unidad', 'u h', 'uh', 'torre', 'bloque', 'block', 'blq', 'bl',
  'piso', 'escalera', 'esc', 'local', 'oficina', 'of', 'manzana', 'mz', 'solar', 'sl',
  'padron', 'frente', 'fondo', 'esquina', 'esq', 'entre', 'porton', 'chacra', 'lote',
  'complejo', 'cooperativa', 'coop', 'edificio', 'edif', 'garaje', 'barbacoa', 'puerta'
];
const REF_RE = new RegExp(
  '(^|[\\s,;(/-])(' + REF_WORDS.map(w => w.replace(/ /g, '\\.?\\s*')).join('|') + ')(?=$|[\\s.,;:)#º°0-9])',
  'i'
);

const REF_START_RE = new RegExp('^(' + REF_WORDS.map(w => w.replace(/ /g, ' ?')).join('|') + ')( |$)');

export function hasRefWord(s) {
  return REF_RE.test(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

/**
 * Separa "Zum Felde 2190, casa" en { address: "Zum Felde 2190", refs: "casa" }.
 * No inventa nada: solo corta el texto existente. Si no hay referencia, refs = "".
 */
export function splitAddress(full) {
  let text = cleanSpaces(full);
  if (!text) return { address: '', refs: '' };
  // "Casa, General Maximo Tajes 7405" / "Oficina, Cambara 1615": la referencia viene antes de la calle
  const lead = text.match(/^([^,\d]{2,30}),\s*(.+)$/);
  if (lead && REF_START_RE.test(normalize(lead[1])) && /\d/.test(lead[2])) {
    const rest = splitAddress(lead[2]);
    return { address: rest.address, refs: cleanSpaces([lead[1], rest.refs].filter(Boolean).join(', ')) };
  }
  // Paréntesis: "(De 9 a 13 y 14 a 18)" es una indicación, no parte de la calle
  const paren = [];
  text = cleanSpaces(text.replace(/\(([^)]*)\)?/g, (_, p) => { if (cleanSpaces(p)) paren.push(cleanSpaces(p)); return ' '; }));
  if (paren.length) {
    const rest = splitAddress(text);
    return { address: rest.address, refs: cleanSpaces([rest.refs, ...paren].filter(Boolean).join(', ')) };
  }
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Buscar la primera palabra de referencia que esté después de algún número de puerta
  // o después de una coma (para no cortar nombres de calle).
  const re = new RegExp(REF_RE.source, 'gi');
  let m;
  while ((m = re.exec(plain)) !== null) {
    const idx = m.index + m[1].length;
    if (idx === 0) continue; // empieza con referencia: no cortar
    const before = plain.slice(0, idx);
    if (/\d/.test(before) || /,\s*$/.test(before)) {
      const address = cleanSpaces(text.slice(0, idx));
      const refs = cleanSpaces(text.slice(idx));
      if (address && refs) return { address, refs };
    }
  }
  // Coma con texto después: lo tratamos como referencia
  const ci = text.indexOf(',');
  if (ci > 0 && /\d/.test(text.slice(0, ci))) {
    return { address: cleanSpaces(text.slice(0, ci)), refs: cleanSpaces(text.slice(ci + 1)) };
  }
  return { address: text, refs: '' };
}

export function fullAddress(item) {
  const a = cleanSpaces(item.address);
  const r = cleanSpaces(item.refs);
  return r ? `${a}, ${r}` : a;
}

/* ---------------- Cédula uruguaya ---------------- */

const CI_WEIGHTS = [2, 9, 8, 7, 6, 3, 4];

export function cedulaCheckDigit(base) {
  const d = String(base).replace(/\D/g, '').padStart(7, '0');
  if (d.length !== 7) return null;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(d[i]) * CI_WEIGHTS[i];
  return (10 - (sum % 10)) % 10;
}

/**
 * Acepta "4.567.890-3", "4567890-3", "45678903", "4567890 3".
 * Devuelve { ok, formatted: "4567890-3", validDigit, error }.
 * ok = formato correcto (7 u 8 dígitos). validDigit = el verificador coincide.
 * Nunca completa ni inventa dígitos.
 */
export function parseCedula(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, formatted: '', validDigit: false, error: 'Falta la cédula' };
  let base, dv;
  const parts = raw.split(/[-‐–—_/\s]+(?=\d\s*$)/);
  if (parts.length === 2) {
    base = parts[0].replace(/\D/g, '');
    dv = parts[1].replace(/\D/g, '');
  } else {
    const digits = raw.replace(/\D/g, '');
    base = digits.slice(0, -1);
    dv = digits.slice(-1);
  }
  if (/[^0-9.\-‐–—_/\s]/.test(raw)) return { ok: false, formatted: '', validDigit: false, error: 'La cédula solo puede tener números, puntos y guion' };
  if (base.length < 6 || base.length > 7 || dv.length !== 1) {
    return { ok: false, formatted: '', validDigit: false, error: 'Debe tener 7 u 8 dígitos (incluido el verificador)' };
  }
  const formatted = `${base}-${dv}`;
  const validDigit = cedulaCheckDigit(base) === Number(dv);
  return { ok: true, formatted, validDigit, error: validDigit ? '' : 'El dígito verificador no coincide. Revisá la cédula.' };
}

/* ---------------- Número de paquete ---------------- */

export function cleanPackage(input) {
  return String(input || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
}

export function validatePackage(input) {
  const p = cleanPackage(input);
  if (!p) return { ok: false, value: '', error: 'Falta el número de paquete' };
  if (!/^[A-Za-z0-9\-]{1,30}$/.test(p)) return { ok: false, value: p, error: 'Solo números, letras o guion' };
  return { ok: true, value: p, error: '' };
}

/* ---------------- Motivos y mensajes ---------------- */

export const REASONS = [
  { code: 'ausente', label: 'Cliente ausente', sentence: 'No se entregó porque el cliente no estaba en casa.' },
  { code: 'direccion', label: 'Dirección incorrecta', sentence: 'No se entregó porque la dirección es incorrecta.' },
  { code: 'no_responde', label: 'Cliente no responde', sentence: 'No se entregó porque el cliente no responde.' },
  { code: 'rechaza', label: 'Cliente rechaza el paquete', sentence: 'No se entregó porque el cliente rechazó el paquete.' },
  { code: 'acceso', label: 'No se pudo acceder al domicilio', sentence: 'No se entregó porque no se pudo acceder al domicilio.' },
  { code: 'otro', label: 'Otro motivo', sentence: null }
];

export function reasonSentence(code, otherText) {
  const r = REASONS.find(x => x.code === code);
  if (!r) return '';
  if (r.sentence) return r.sentence;
  let t = cleanSpaces(otherText);
  if (!t) return '';
  if (/^no se entreg/i.test(normalize(t).replace(/ /g, ' '))) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  } else {
    // "El perro no dejaba pasar" -> "No se entregó porque el perro no dejaba pasar."
    if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(t)) t = t.charAt(0).toLowerCase() + t.slice(1);
    t = 'No se entregó porque ' + t.replace(/^porque\s+/i, '');
  }
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}

// Los reportes llevan pedido y empresa; la dirección no va (sin empresa, esa línea no va).

/** "#1162\nAquora\n1234567-2" */
export function buildDeliveredMessage({ pkg, company, cedula }) {
  return [`#${cleanPackage(pkg)}`, cleanSpaces(company), cedula].filter(Boolean).join('\n');
}

/** "#1162\nAquora\nNo se entregó porque el cliente no estaba en casa." */
export function buildFailedMessage({ pkg, company, reasonCode, reasonText }) {
  return [`#${cleanPackage(pkg)}`, cleanSpaces(company), reasonSentence(reasonCode, reasonText)].filter(Boolean).join('\n');
}

/* ---------------- Teléfono y enlaces WhatsApp ---------------- */

/** Normaliza a formato internacional sin "+" (Uruguay por defecto). "099 123 456" -> "59899123456" */
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('09')) d = '598' + d.slice(1);
  else if (d.length === 8 && d.startsWith('9')) d = '598' + d;
  return d;
}

export function isValidPhone(d) {
  return /^\d{10,15}$/.test(d);
}

/**
 * mode "app": esquema whatsapp:// (lo abre iOS directamente, el texto no pasa por internet).
 * mode "web": enlace oficial wa.me (pasa por el navegador/servidor de WhatsApp si la app no lo intercepta).
 */
export function whatsappUrl(phone, text, mode = 'app') {
  const t = encodeURIComponent(text);
  if (mode === 'web') return `https://wa.me/${phone}?text=${t}`;
  return `whatsapp://send?phone=${phone}&text=${t}`;
}

/* ---------------- Búsqueda ---------------- */

export function matchesQuery(item, q) {
  const tokens = normalize(q).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const hay = normalize([item.address, item.refs, item.original, item.pkg, item.orderNo, item.company, item.zone].join(' '));
  return tokens.every(t => hay.includes(t));
}

/* ---------------- Duplicados ---------------- */

export function dupKey(text) { return normalize(text); }
export function baseKey(text) { return normalize(splitAddress(text).address); }

/**
 * rows: [{text}] ; existing: [{text}] (ya en la jornada)
 * Marca en cada fila: dupRows (índices de filas iguales), dupExisting (n en jornada),
 * similar (misma calle y número, distinta referencia). No elimina nada.
 */
export function markDuplicates(rows, existing = []) {
  const keys = rows.map(r => dupKey(r.text));
  const bases = rows.map(r => baseKey(r.text));
  const exKeys = existing.map(e => dupKey(e.text));
  const exBases = existing.map(e => baseKey(e.text));
  rows.forEach((r, i) => {
    r.dupRows = []; r.similarRows = [];
    if (!keys[i]) { r.dupExisting = 0; r.similarExisting = 0; return; }
    keys.forEach((k, j) => {
      if (j === i) return;
      if (k === keys[i]) r.dupRows.push(j);
      else if (bases[j] && bases[j] === bases[i]) r.similarRows.push(j);
    });
    r.dupExisting = exKeys.filter(k => k === keys[i]).length;
    r.similarExisting = exBases.filter((b, j) => b === bases[i] && exKeys[j] !== keys[i]).length;
  });
  return rows;
}

/* ---------------- OCR: de palabras a filas/columnas ---------------- */

const GRID_RE = /^[|\[\]_¦‖—–\-=:;.,'"`~]+$/;

/** Puntuación de "parece dirección" para el texto de una celda (0..1). */
export function addressScore(text) {
  const t = cleanSpaces(text);
  if (!t) return 0;
  const n = normalize(t);
  let s = 0;
  const hasWord = /[a-zñ]{3,}/.test(n);
  const hasDoor = /(^|\s)\d{1,5}(\s|$|[a-z]\b)/.test(n) || /\d{1,5}\s*(bis|[a-z])?$/.test(n);
  if (hasWord) s += 0.4;
  if (hasDoor) s += 0.4;
  if (hasRefWord(t)) s += 0.15;
  if (/\b(av|avda|avenida|calle|bv|bulevar|camino|ruta|pasaje|rambla|gral|ing|dr)\b/.test(n)) s += 0.15;
  if (/\d{7,}/.test(t.replace(/[\s.\-]/g, '')) && !/[a-z]{3,}/.test(n)) s -= 0.8; // teléfono / cédula
  if (/\b0?9\d{7}\b/.test(t.replace(/[\s.\-]/g, ''))) s -= 0.5;              // celular
  if (/\d{1,2}\/\d{1,2}(\/\d{2,4})?/.test(t)) s -= 0.5;                        // fecha
  if (/[$€]|\buyu\b|\busd\b/i.test(t)) s -= 0.5;
  if (!hasWord) s -= 0.3;
  if (REF_START_RE.test(n)) s -= 0.45; // empieza con casa/apto/torre...: es una referencia, no la calle
  return Math.max(0, Math.min(1, s));
}

const HEADER_WORDS = new Set(['direccion', 'domicilio', 'calle', 'destinatario', 'nombre', 'telefono', 'celular', 'tel',
  'barrio', 'localidad', 'referencia', 'referencias', 'observaciones', 'obs', 'zona', 'cliente', 'n', 'no', 'nº', 'nro', 'numero',
  'item', 'puerta', 'departamento', 'ciudad', 'entrega', 'de', 'y', 'o', 'cp', 'codigo', 'postal', 'ref',
  'empresa', 'pedido', 'orden', 'comercio', 'tienda', 'marca', 'remitente', 'id', 'envio', 'paquete']);

/** Encabezado de tabla: sin dígitos y casi todas las palabras son títulos típicos. */
export function isHeaderLike(text) {
  const n = normalize(text);
  if (!n || /\d/.test(n)) return false;
  const toks = n.split(' ');
  const hits = toks.filter(t => HEADER_WORDS.has(t)).length;
  const strong = toks.some(t => ['direccion', 'domicilio', 'telefono', 'barrio', 'referencia', 'destinatario', 'observaciones', 'localidad', 'celular', 'empresa', 'pedido'].includes(t));
  return strong && hits / toks.length >= 0.6;
}

/* ---------------- Columnas: qué es cada una ---------------- */

// Barrios y localidades frecuentes (Montevideo y zona metropolitana), sin tildes.
const ZONES = new Set(['aguada', 'aires puros', 'atahualpa', 'banados de carrasco', 'barrio sur', 'bella italia', 'bella vista',
  'belvedere', 'brazo oriental', 'buceo', 'capurro', 'carrasco', 'carrasco norte', 'casabo', 'casavalle', 'castro', 'centro',
  'cerrito', 'cerro', 'cerro norte', 'ciudad vieja', 'colon', 'conciliacion', 'cordon', 'flor de maronas', 'ituzaingo',
  'jacinto vera', 'jardines del hipodromo', 'la blanqueada', 'la comercial', 'la figurita', 'la paloma', 'la teja', 'larranaga',
  'larrañaga', 'las acacias', 'las canteras', 'lezica', 'malvin', 'malvin norte', 'malvin alto', 'manga', 'maronas', 'maroñas',
  'melilla', 'mercado modelo', 'nuevo paris', 'palermo', 'parque batlle', 'parque rodo', 'paso de la arena', 'paso de las duranas',
  'penarol', 'peñarol', 'piedras blancas', 'pocitos', 'pocitos nuevo', 'prado', 'punta carretas', 'punta de rieles', 'punta gorda',
  'punta rieles', 'reducto', 'sayago', 'tres cruces', 'tres ombues', 'union', 'villa dolores', 'villa espanola', 'villa española',
  'villa garcia', 'villa munoz', 'villa muñoz', 'colinas de carrasco', 'shangrila', 'solymar', 'lagomar', 'el pinar',
  'ciudad de la costa', 'las piedras', 'la paz', 'pando', 'paso carrasco', 'barra de carrasco', 'parque miramar',
  'san jose de carrasco', 'montevideo', 'canelones', 'parque del plata', 'atlantida', 'progreso', 'toledo', 'barros blancos']);

export const ROLE_LABEL = { address: 'Dirección', order: 'Pedido', company: 'Empresa', zone: 'Barrio', none: 'No usar' };
export const ROLE_CYCLE = ['address', 'order', 'company', 'zone', 'none'];

const digitsOf = t => String(t || '').replace(/[\s.\-+()]/g, '');
const isPhone = t => { const d = digitsOf(t); return /^\d{8,13}$/.test(d) && /^(0?9|598|2|4)/.test(d); };
const isZone = t => { const n = normalize(t); return ZONES.has(n) || [...ZONES].some(z => z.length > 4 && n.startsWith(z + ' ')); };
const isOrderLike = t => /^[#H+*]?\d{3,7}$/.test(String(t || '').replace(/\s+/g, ''));
const isShortText = t => !/\d/.test(t) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(t) && t.trim().split(/\s+/).length <= 3;
const isNameLike = t => !/\d/.test(t) && /^([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ'.]*\s+){1,4}[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ'.]*$/.test(t.trim());

/**
 * Normaliza la columna de pedidos. Tesseract a veces lee "#" como "4" ("#1162" -> "41162"):
 * solo se corrige cuando la propia columna lo demuestra (otras celdas con "#" del mismo largo,
 * o todas empiezan con 4 y tienen el mismo largo).
 */
export function orderFixer(texts) {
  const clean = t => String(t || '').replace(/\s+/g, '').replace(/^[H+*]/, '#');
  const cl = texts.map(clean);
  const lens = cl.filter(t => /^#\d+$/.test(t)).map(t => t.length - 1);
  let L = lens.length ? median(lens) : 0;
  if (!L) {
    const plain = cl.filter(t => /^\d+$/.test(t));
    if (plain.length >= 3 && plain.every(t => t.length === plain[0].length) && plain.filter(t => t[0] === '4').length / plain.length >= 0.8) L = plain[0].length - 1;
  }
  return t => {
    const c = clean(t);
    if (/^#\d+$/.test(c)) return { value: c.slice(1), fixed: false };
    if (L && /^4\d+$/.test(c) && c.length === L + 1) return { value: c.slice(1), fixed: true };
    if (/^\d{3,7}$/.test(c)) return { value: c, fixed: false };
    const v = c.replace(/[^0-9A-Za-z-]/g, '');
    return { value: v, fixed: false, dubious: true };
  };
}

/**
 * Decide qué es cada columna mirando su contenido (y el encabezado, si hay).
 * columns: [{ index, x0, x1, texts: [...], title }]. Devuelve { [index]: role }.
 */
export function classifyColumns(columns) {
  const roles = {};
  const share = (texts, f) => texts.length ? texts.filter(f).length / texts.length : 0;
  const info = columns.map(c => {
    const t = c.texts;
    const nums = t.map(x => digitsOf(x));
    const seq = t.length >= 2 && nums.every(x => /^\d{1,4}$/.test(x)) &&
      nums.slice(1).every((x, i) => Number(x) === Number(nums[i]) + 1);
    return {
      c, n: t.length, seq,
      phone: share(t, isPhone),
      order: share(t, isOrderLike), hash: share(t, x => /^\s*[#H*]/.test(x)),
      zone: share(t, isZone), short: share(t, isShortText), name: share(t, isNameLike),
      repeat: t.length ? 1 - new Set(t.map(normalize)).size / t.length : 0,
      words: t.length ? t.reduce((s, x) => s + x.trim().split(/\s+/).length, 0) / t.length : 0,
      title: normalize(c.title)
    };
  });
  const free = () => info.filter(i => !roles[i.c.index]);
  // Encabezados explícitos
  for (const i of info) {
    if (/\b(empresa|comercio|tienda|marca|remitente)\b/.test(i.title)) roles[i.c.index] = 'company';
    else if (/\b(pedido|orden|envio|paquete)\b/.test(i.title)) roles[i.c.index] = 'order';
    else if (/\b(barrio|zona|localidad)\b/.test(i.title)) roles[i.c.index] = 'zone';
    else if (/\b(telefono|celular|tel|nombre|destinatario)\b/.test(i.title)) roles[i.c.index] = 'none';
  }
  // Números de fila de Excel y teléfonos: no se usan
  for (const i of free()) if (i.seq || i.phone >= 0.6) roles[i.c.index] = 'none';
  // Pedido
  if (!Object.values(roles).includes('order')) {
    const cand = free().filter(i => i.order >= 0.6 || i.hash >= 0.3).sort((a, b) => (b.hash + b.order) - (a.hash + a.order))[0];
    if (cand) roles[cand.c.index] = 'order';
  }
  // Dirección: la columna con más pinta de dirección, más las de referencias
  const ranked = free().filter(i => i.n >= 1).sort((a, b) => b.c.score - a.c.score);
  if (ranked.length && ranked[0].c.score >= 0.35) {
    roles[ranked[0].c.index] = 'address';
    for (const i of free()) if (i.c.refShare >= 0.5) roles[i.c.index] = 'address';
  }
  // Barrio
  if (!Object.values(roles).includes('zone')) {
    const cand = free().filter(i => i.zone >= 0.4).sort((a, b) => b.zone - a.zone)[0];
    if (cand) roles[cand.c.index] = 'zone';
  }
  // Empresa: texto corto que se repite, preferentemente a la izquierda del pedido; no nombres de personas
  if (!Object.values(roles).includes('company')) {
    const orderCol = info.find(i => roles[i.c.index] === 'order');
    const cand = free().filter(i => i.short >= 0.7).map(i => ({
      i, s: i.repeat * 2 + (orderCol && i.c.x1 <= orderCol.c.x0 + 2 ? 1 : 0) + (i.words <= 1.5 ? 0.5 : 0) - (i.name >= 0.6 && i.words >= 1.8 ? 1.5 : 0)
    })).sort((a, b) => b.s - a.s)[0];
    if (cand && cand.s >= 1) roles[cand.i.c.index] = 'company';
  }
  for (const i of free()) roles[i.c.index] = 'none';
  // Si no se encontró dirección, usar todo lo que no sea número de fila/teléfono
  if (!Object.values(roles).includes('address')) {
    for (const i of info) if (roles[i.c.index] === 'none' && !i.seq && i.phone < 0.6 && i.name < 0.6) roles[i.c.index] = 'address';
  }
  return roles;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/**
 * Detecta las líneas de la grilla de Excel (horizontales y verticales) en una imagen en escala de grises.
 * gray: Uint8Array (width*height). Devuelve { h: [y...], v: [x...] } (centros de cada línea).
 * Una línea de grilla = tramo largo y delgado que se distingue de lo que tiene a ambos lados:
 *  - más oscura (grilla común sobre fondo blanco), o
 *  - más clara (líneas blancas entre filas pintadas de color).
 * Además, los bordes de una banda rellena (p. ej. encabezado gris) cuentan como límites.
 */
export function detectGrid(gray, width, height) {
  const K = Math.max(3, Math.round(Math.min(width, height) / 300)); // distancia a los vecinos
  const T = 12;                                                    // diferencia mínima de brillo
  // Fondo general (para los bordes de bandas rellenas)
  const sample = [];
  for (let i = 0; i < gray.length; i += Math.max(1, Math.floor(gray.length / 5000))) sample.push(gray[i]);
  const bg = median(sample);
  const dark = bg < 128;
  const isInk = v => (dark ? v - bg > 18 : bg - v > 18);

  const scan = (len, across, get, minRunFrac) => {
    const thin = new Uint8Array(across), filled = new Uint8Array(across);
    const longRun = (test) => {
      let best = 0, run = 0, gap = 0;
      for (let b = 0; b < len; b++) {
        if (test(b)) { run += 1 + gap; gap = 0; if (run > best) best = run; }
        else if (run > 0 && gap < 3) gap++;
        else { run = 0; gap = 0; }
      }
      return best >= len * minRunFrac;
    };
    for (let a = 0; a < across; a++) {
      if (a >= K && a < across - K) {
        thin[a] = longRun(b => {
          const c = get(a, b), p = get(a - K, b), n = get(a + K, b);
          // línea clara, línea oscura, o cambio de color de fondo (fila de otro color, columna de números de fila)
          return c - Math.max(p, n) > T || Math.min(p, n) - c > T || Math.abs(p - n) > 2 * T;
        }) ? 1 : 0;
      }
      filled[a] = longRun(b => isInk(get(a, b))) ? 1 : 0;
    }
    const out = [];
    const maxThin = 2 * K + 3;
    for (let a = 0; a < across; a++) {
      if (!thin[a]) continue;
      let b = a; while (b + 1 < across && thin[b + 1]) b++;
      if (b - a + 1 <= maxThin) out.push((a + b) / 2);
      a = b;
    }
    const maxThick = Math.max(6, Math.round(across * 0.006));
    for (let a = 0; a < across; a++) {
      if (!filled[a]) continue;
      let b = a; while (b + 1 < across && filled[b + 1]) b++;
      if (b - a + 1 <= maxThick) out.push((a + b) / 2);
      else { if (a > 0) out.push(a); if (b < across - 1) out.push(b); }
      a = b;
    }
    // unir líneas casi superpuestas (la misma línea detectada por los dos criterios)
    out.sort((x, y) => x - y);
    const merged = [];
    for (const p of out) {
      if (merged.length && p - merged[merged.length - 1] <= K + 2) merged[merged.length - 1] = (merged[merged.length - 1] + p) / 2;
      else merged.push(p);
    }
    return merged;
  };
  const h = scan(width, height, (y, x) => gray[y * width + x], 0.4);
  const v = scan(height, width, (x, y) => gray[y * width + x], 0.25);
  return { h, v };
}

function linesOf(words, h) {
  const ws = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const lines = [];
  for (const w of ws) {
    const yc = (w.y0 + w.y1) / 2;
    let line = lines.find(l => Math.abs(l.yc - yc) < h * 0.55);
    if (!line) { line = { yc, words: [] }; lines.push(line); }
    line.words.push(w);
    line.yc = line.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / line.words.length;
  }
  lines.sort((a, b) => a.yc - b.yc);
  lines.forEach(l => l.words.sort((a, b) => a.x0 - b.x0));
  return lines;
}

function makeCell(words, h) {
  const lines = linesOf(words, h);
  const text = cleanSpaces(lines.map(l => l.words.map(w => w.text).join(' ')).join(' ').replace(/[|¦‖]/g, ' '));
  return {
    text, words,
    conf: Math.min(...words.map(w => (typeof w.conf === 'number' ? w.conf : 100))),
    x0: Math.min(...words.map(w => w.x0)), x1: Math.max(...words.map(w => w.x1)),
    y0: Math.min(...words.map(w => w.y0)), y1: Math.max(...words.map(w => w.y1))
  };
}

/**
 * Líneas falsas (sombras, bordes del texto en filas de color) dejan "filas" finitas con un pedazo
 * de texto. Una banda mucho más baja que las demás y sin ninguna línea completa (3+ columnas)
 * se une a la banda vecina cuyo texto está más cerca.
 */
function mergeOrphans(bands, lh) {
  const out = bands.slice();
  const minH = Math.max(lh * 1.15, median(out.map(b => b.y1 - b.y0)) * 0.6);
  const yc = w => (w.y0 + w.y1) / 2;
  const hasFull = b => linesOf(b.words, lh).some(l => splitByGaps(l.words, lh * 0.95).length >= 3);
  for (let k = 0; k < out.length && out.length > 1;) {
    const b = out[k];
    if (b.y1 - b.y0 >= minH || hasFull(b)) { k++; continue; }
    const c = median(b.words.map(yc));
    const dist = n => (n ? Math.min(...n.words.map(w => Math.abs(yc(w) - c))) : Infinity);
    const t = dist(out[k - 1]) <= dist(out[k + 1]) ? out[k - 1] : out[k + 1];
    t.words.push(...b.words);
    t.y0 = Math.min(t.y0, b.y0); t.y1 = Math.max(t.y1, b.y1); t.cut = t.cut && b.cut;
    out.splice(k, 1);
  }
  return out;
}

/**
 * Filas del mismo color a veces no tienen línea divisoria: una banda puede tener varios registros.
 * Se divide solo si mide varias veces la altura típica de fila (rowH) y tiene al menos esa
 * cantidad de líneas "completas" (texto en 3 o más columnas). Una fila con celdas de varias
 * líneas tiene una sola línea completa (la del medio), así que no se corta.
 */
function splitMergedBands(bands, lh, rowH) {
  const out = [];
  for (const b of bands) {
    const n = rowH ? Math.round((b.y1 - b.y0) / rowH) : 1;
    if (n < 2) { out.push(b); continue; }
    const lines = linesOf(b.words, lh);
    const groups = lines.map(l => splitByGaps(l.words, lh * 0.95).length);
    const maxG = Math.max(0, ...groups);
    const full = groups.filter(g => g >= Math.max(3, Math.ceil(maxG * 0.6))).length;
    if (full < n) { out.push(b); continue; }
    const h = (b.y1 - b.y0) / n;
    for (let i = 0; i < n; i++) {
      const y0 = b.y0 + i * h, y1 = i === n - 1 ? b.y1 : y0 + h;
      const words = b.words.filter(w => { const c = (w.y0 + w.y1) / 2; return c >= y0 && (c < y1 || i === n - 1); });
      if (words.length) out.push({ y0, y1, cut: (i === 0 || i === n - 1) && b.cut, words });
    }
  }
  return out;
}

function splitByGaps(lineWords, gap) {
  const groups = [];
  let cur = null;
  for (const w of lineWords) {
    if (!cur || w.x0 - cur.x1 > gap) { cur = { x1: w.x1, words: [w] }; groups.push(cur); }
    else { cur.words.push(w); cur.x1 = Math.max(cur.x1, w.x1); }
  }
  return groups.map(g => g.words);
}

/**
 * Analiza la tabla. words: [{ text, conf, x0, y0, x1, y1 }]; grid: { h:[], v:[] } (opcional);
 * size: { width, height } (opcional).
 * Devuelve { rows: [{ y0, y1, cut, byCol: {col: cell}, header }], columns: [...], selected: [...] }
 */
export function analyzeTable(words, grid = { h: [], v: [] }, size = null) {
  const ws = words
    .map(w => ({ ...w, text: String(w.text || '').trim() }))
    .filter(w => w.text && w.x1 > w.x0 && w.y1 > w.y0)
    .filter(w => !(/^[|\[\]¦‖_]+$/.test(w.text))) // restos de la grilla
    .filter(w => !(typeof w.conf === 'number' && w.conf < 25 && w.text.length <= 3 && !/\d/.test(w.text))); // ruido
  const lh = median(ws.map(w => w.y1 - w.y0)) || 20;
  const H = size?.height || Math.max(0, ...ws.map(w => w.y1)) + 1;
  const W = size?.width || Math.max(0, ...ws.map(w => w.x1)) + 1;

  // 1) Filas
  let bands = [];
  const hs = (grid.h || []).slice().sort((a, b) => a - b);
  if (hs.length >= 2) {
    const edges = [0, ...hs, H];
    for (let i = 0; i < edges.length - 1; i++) bands.push({ y0: edges[i], y1: edges[i + 1], cut: i === 0 || i === edges.length - 2 });
    bands.forEach(b => { b.words = ws.filter(w => { const c = (w.y0 + w.y1) / 2; return c >= b.y0 && c < b.y1; }); });
    bands = bands.filter(b => b.words.length);
    // Una banda "cortada" sólo cuenta como cortada si está pegada al borde de la imagen
    bands.forEach(b => { b.cut = b.cut && (b.y0 <= 1 || b.y1 >= H - 1) && (b.y1 - b.y0) < lh * 1.4 ? true : false; });
    bands = mergeOrphans(bands, lh);
    // Altura típica de fila: la más común entre las bandas con texto
    const rowH = median(bands.filter(b => !b.cut).map(b => b.y1 - b.y0));
    bands = splitMergedBands(bands, lh, rowH);
    // Que cada fila abarque todo su texto (para el recorte que se muestra al revisar)
    bands.forEach(b => {
      b.y0 = Math.max(0, Math.min(b.y0, ...b.words.map(w => w.y0 - 3)));
      b.y1 = Math.min(H, Math.max(b.y1, ...b.words.map(w => w.y1 + 3)));
    });
  } else {
    bands = linesOf(ws, lh).map(l => ({
      y0: Math.min(...l.words.map(w => w.y0)), y1: Math.max(...l.words.map(w => w.y1)), cut: false, words: l.words
    }));
  }

  // 2) Columnas
  let columns = [];
  const vs = (grid.v || []).slice().sort((a, b) => a - b);
  if (vs.length >= 2) {
    const edges = [0, ...vs, W];
    for (let i = 0; i < edges.length - 1; i++) if (edges[i + 1] - edges[i] > lh * 0.8) columns.push({ x0: edges[i], x1: edges[i + 1] });
    for (const b of bands) {
      b.byCol = {};
      columns.forEach((c, ci) => {
        const cw = b.words.filter(w => { const x = (w.x0 + w.x1) / 2; return x >= c.x0 && x < c.x1; });
        if (cw.length) b.byCol[ci] = makeCell(cw, lh);
      });
    }
  } else {
    // Sin grilla vertical: separar por espacios grandes y unir intervalos entre filas
    const gap = lh * 0.95;
    for (const b of bands) {
      b.cells = [];
      for (const l of linesOf(b.words, lh)) for (const g of splitByGaps(l.words, gap)) b.cells.push(makeCell(g, lh));
    }
    const ivs = [];
    for (const b of bands) {
      if (isHeaderLike(b.cells.map(c => c.text).join(' '))) continue;
      for (const c of b.cells) ivs.push([c.x0, c.x1]);
    }
    ivs.sort((a, b) => a[0] - b[0]);
    for (const [a, z] of ivs) {
      const last = columns[columns.length - 1];
      if (last && a <= last.x1) last.x1 = Math.max(last.x1, z); else columns.push({ x0: a, x1: z });
    }
    for (const b of bands) {
      b.byCol = {};
      const groups = {};
      for (const c of b.cells) {
        let best = 0, bestV = -Infinity;
        columns.forEach((col, ci) => {
          const ov = Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0);
          const v = ov > 0 ? ov : -Math.abs((c.x0 + c.x1) / 2 - (col.x0 + col.x1) / 2);
          if (v > bestV) { bestV = v; best = ci; }
        });
        (groups[best] = groups[best] || []).push(...c.words);
      }
      for (const k in groups) b.byCol[k] = makeCell(groups[k], lh);
    }
  }
  columns = columns.map((c, i) => ({ index: i, x0: c.x0, x1: c.x1 }));

  for (const b of bands) b.header = isHeaderLike(Object.values(b.byCol).map(c => c.text).join(' '));
  const data = bands.filter(b => !b.header);
  columns.forEach(col => {
    const texts = data.map(b => b.byCol[col.index]?.text).filter(Boolean);
    col.texts = texts;
    col.filled = texts.length;
    col.score = texts.length ? texts.reduce((s, t) => s + addressScore(t), 0) / texts.length : 0;
    col.refShare = texts.length ? texts.filter(t => hasRefWord(t) && !/\d{6,}/.test(t.replace(/\s/g, ''))).length / texts.length : 0;
    col.sample = texts.slice(0, 2).join(' · ').slice(0, 60);
    const head = bands.find(b => b.header && b.byCol[col.index]);
    col.title = head ? head.byCol[col.index].text : '';
  });
  // Columnas casi vacías (restos de otra columna, bordes): no cuentan para decidir
  const minFill = Math.max(1, data.length * 0.3);
  const roles = classifyColumns(columns.filter(c => c.filled >= minFill));
  columns.forEach(c => { if (!roles[c.index]) roles[c.index] = 'none'; });
  const selected = columns.filter(c => roles[c.index] === 'address').map(c => c.index);
  return { rows: bands, columns, roles, selected, lineHeight: lh };
}

/**
 * Construye las filas a revisar. roles: { [col]: 'address'|'order'|'company'|'zone'|'none' }
 * (o, por compatibilidad, un array con las columnas de dirección).
 * Devuelve [{ text, orderNo, company, zone, conf, lowConf, reasons:[], raw, y0, y1, x0, x1 }]
 */
export function buildRows(analysis, roles, lowThreshold = 75) {
  if (Array.isArray(roles)) roles = Object.fromEntries(roles.map(c => [c, 'address']));
  const cols = role => Object.keys(roles).filter(k => roles[k] === role).map(Number).sort((a, b) => a - b);
  const addrCols = cols('address'), orderCol = cols('order')[0], companyCol = cols('company')[0], zoneCol = cols('zone')[0];
  const data = analysis.rows.filter(b => !b.header);
  const fixOrder = orderCol !== undefined ? orderFixer(data.map(b => b.byCol[orderCol]?.text).filter(Boolean)) : null;
  const orderLen = fixOrder ? median(data.map(b => b.byCol[orderCol]).filter(Boolean).map(c => fixOrder(c.text).value.length)) : 0;
  const out = [];
  for (const b of data) {
    const parts = addrCols.map(ci => b.byCol[ci]).filter(Boolean);
    if (!parts.length) continue;
    const text = cleanSpaces(parts.map(p => p.text).join(', ').replace(/,\s*,/g, ','));
    if (!text || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(text)) continue;
    const conf = Math.round(Math.min(...parts.map(p => p.conf)));
    const reasons = [];
    if (b.cut) reasons.push('Fila cortada en la captura');
    if (conf < lowThreshold) reasons.push(`Lectura dudosa (${conf}%)`);
    if (!/\d/.test(text)) reasons.push('Sin número de puerta');
    if (/[~¦@{}<>\\^*]/.test(text)) reasons.push('Caracteres extraños');
    let orderNo = '';
    if (fixOrder) {
      const cell = b.byCol[orderCol];
      if (!cell) reasons.push('Sin número de pedido');
      else {
        const o = fixOrder(cell.text);
        orderNo = o.value;
        if (o.dubious || o.value.length !== orderLen || (cell.conf < 30 && !o.fixed)) reasons.push('Revisar número de pedido');
      }
    }
    const textOf = ci => (ci === undefined ? '' : cleanSpaces(b.byCol[ci]?.text || ''));
    out.push({
      text, orderNo, company: textOf(companyCol), zone: textOf(zoneCol),
      conf, lowConf: reasons.length > 0, reasons,
      raw: Object.keys(b.byCol).sort((x, y) => x - y).map(k => b.byCol[k].text).join(' | '),
      y0: b.y0, y1: b.y1,
      x0: Math.min(...parts.map(p => p.x0)), x1: Math.max(...parts.map(p => p.x1))
    });
  }
  return out;
}

/** Texto pegado (Texto en vivo de iOS o escrito a mano): una dirección por línea. Un "#1234" se toma como pedido. */
export function rowsFromText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => cleanSpaces(l.replace(/\t+/g, ', ')))
    .filter(l => l && !isHeaderLike(l) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(l))
    .map(raw => {
      let orderNo = '';
      const t = cleanSpaces(raw.replace(/(^|[\s,])#\s?(\d{3,7})\b/, (_, a, n) => { orderNo = n; return a; }));
      return { text: t, orderNo, company: '', zone: '', conf: 100, lowConf: !/\d/.test(t), reasons: /\d/.test(t) ? [] : ['Sin número de puerta'], raw };
    });
}

/* ---------------- Mapa: preparar la búsqueda de la dirección ---------------- */

const ABBREV = [
  [/\bav(?:da)?\.?(?=\s)/gi, 'Avenida'], [/\bgral\.?(?=\s)/gi, 'General'], [/\bdra\.?(?=\s)/gi, 'Doctora'], [/\bdr\.?(?=\s)/gi, 'Doctor'],
  [/\bing\.?(?=\s)/gi, 'Ingeniero'], [/\bbv(?:ar)?\.?(?=\s)/gi, 'Bulevar'], [/\bcno\.?(?=\s)/gi, 'Camino'], [/\brbla\.?(?=\s)/gi, 'Rambla'],
  [/\bpte\.?(?=\s)/gi, 'Presidente'], [/\bcnel\.?(?=\s)/gi, 'Coronel'], [/\bmcal\.?(?=\s)/gi, 'Mariscal'], [/\bprof\.?(?=\s)/gi, 'Profesor'],
  [/\bsta\.?(?=\s)/gi, 'Santa'], [/\bsto\.?(?=\s)/gi, 'Santo'], [/\bgdor\.?(?=\s)/gi, 'Gobernador'], [/\bpje\.?(?=\s)/gi, 'Pasaje']
];
export function expandAbbrev(s) {
  let t = ' ' + cleanSpaces(s) + ' ';
  for (const [re, w] of ABBREV) t = t.replace(re, w);
  return cleanSpaces(t.replace(/\.(?=\S)/g, '. '));
}

/**
 * De "Av Gral Rivera 4221" saca { street: "Avenida General Rivera", number: "4221" }.
 * Usa el primer tramo (separado por comas) que tenga calle + número de puerta.
 */
export function geoParts(address) {
  const segs = cleanSpaces(address).split(/[,;]/).map(s => cleanSpaces(s)).filter(Boolean);
  for (const s of segs) {
    if (REF_START_RE.test(normalize(s))) continue;
    // El número de puerta no es el de "8 de Octubre" / "18 de Julio" (número seguido de "de")
    const m = s.match(/^(.*?[A-Za-zÁÉÍÓÚÜÑáéíóúüñ].*?)\s+(?:n[º°o]\.?\s*)?(\d{1,5})(?!\s+de\s)(?:\s*(bis)\b)?(?=$|[\s.,;])/i);
    if (m) return { street: expandAbbrev(m[1]).replace(/[\s.,]+$/, ''), number: m[2] };
  }
  return { street: expandAbbrev(segs.find(s => !REF_START_RE.test(normalize(s))) || segs[0] || '').replace(/[\s.,]+$/, ''), number: '' };
}

/**
 * Lista de búsquedas a probar en orden (la primera que encuentre algo gana).
 * exact: si encuentra, es la puerta; si no, es aproximada (solo la calle).
 */
export function geoQueries({ address, zone }, city = 'Montevideo') {
  const { street, number } = geoParts(address);
  if (!street) return [];
  const noInitial = street.replace(/^[A-ZÁÉÍÓÚÑ]\.?\s+(?=\S{3,})/, '');
  const qs = [];
  const add = (q, exact) => { if (!qs.some(x => JSON.stringify(x.q) === JSON.stringify(q))) qs.push({ q, exact }); };
  if (number) {
    if (zone) add({ q: `${street} ${number}, ${zone}, ${city}` }, true);
    add({ street: `${number} ${street}`, city }, true);
    if (noInitial !== street) add({ street: `${number} ${noInitial}`, city }, true);
  }
  if (zone) add({ q: `${street}, ${zone}, ${city}` }, false);
  add({ street, city }, false);
  if (noInitial !== street) add({ street: noInitial, city }, false);
  return qs;
}

/* ---------------- Ruta: orden de visita ---------------- */

export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Recorrido abierto de menor costo (vecino más cercano desde cada inicio posible + mejora 2-opt).
 * n nodos; si hasStart, el nodo 0 es el punto de partida fijo y no se devuelve.
 * cost(i, j): costo de ir de i a j (puede ser asimétrico, p. ej. minutos de manejo).
 * Devuelve los índices de nodo en orden de visita.
 */
export function orderByCost(n, hasStart, cost) {
  const stops = [];
  for (let i = hasStart ? 1 : 0; i < n; i++) stops.push(i);
  if (stops.length <= 1) return stops;
  const pathCost = ord => {
    let c = 0;
    for (let i = 1; i < ord.length; i++) c += cost(ord[i - 1], ord[i]);
    return c + (hasStart ? cost(0, ord[0]) : 0);
  };
  const nearest = first => {
    const left = new Set(stops); const ord = [];
    let cur = first;
    if (!hasStart) { ord.push(first); left.delete(first); }
    while (left.size) {
      let best = -1, bd = Infinity;
      for (const j of left) { const d = cost(cur, j); if (d < bd) { bd = d; best = j; } }
      ord.push(best); left.delete(best); cur = best;
    }
    return ord;
  };
  // Con inicio fijo hay un solo arranque; sin inicio se prueba arrancar desde cada parada.
  let order = null, bestCost = Infinity;
  for (const s of hasStart ? [0] : stops) {
    const o = nearest(s), c = pathCost(o);
    if (c < bestCost) { bestCost = c; order = o; }
  }
  // Mejoras mientras haya (se recalcula el costo completo porque puede ser asimétrico):
  //  - 2-opt: invertir un tramo.
  //  - Or-opt: sacar un grupo de paradas seguidas y ponerlo en otro lugar (derecho o invertido),
  //    p. ej. las paradas cerca del inicio que quedaron para el final.
  const m = order.length;
  const maxSeg = Math.min(m - 1, 12);
  let improved = true, guard = 0;
  while (improved && guard++ < 30) {
    improved = false;
    for (let i = 0; i < m - 1; i++) {
      for (let k = i + 1; k < m; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        const c = pathCost(cand);
        if (c < bestCost - 1e-6) { order = cand; bestCost = c; improved = true; }
      }
    }
    for (let len = 1; len <= maxSeg; len++) {
      for (let i = 0; i + len <= m; i++) {
        const seg = order.slice(i, i + len);
        const rest = [...order.slice(0, i), ...order.slice(i + len)];
        for (let p = 0; p <= rest.length; p++) {
          if (p === i) continue;
          for (const s of [seg, seg.slice().reverse()]) {
            const cand = [...rest.slice(0, p), ...s, ...rest.slice(p)];
            const c = pathCost(cand);
            if (c < bestCost - 1e-6) { order = cand; bestCost = c; improved = true; }
          }
        }
      }
    }
  }
  return order;
}

/**
 * Orden de visita en línea recta (sin servidor). points: [{lat,lng}]; start: {lat,lng} o null.
 * Devuelve índices de points en orden.
 */
export function optimizeOrder(points, start = null) {
  const nodes = start ? [start, ...points] : points;
  const ord = orderByCost(nodes.length, !!start, (i, j) => distanceM(nodes[i], nodes[j]));
  return start ? ord.map(i => i - 1) : ord;
}

export function fmtKm(m) { return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`; }
export function fmtMin(s) { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }

/* ---------------- Estados ---------------- */

export const STATUS_LABEL = { pending: 'Pendiente', delivered: 'Entregado', failed: 'No entregado' };
export const SEND_LABEL = {
  none: '',
  prepared: 'Preparado, sin enviar',
  awaiting: 'Pendiente de confirmar en WhatsApp',
  sent: 'Enviado (confirmado)',
  error: 'No enviado / no confirmado'
};

export function todayISO(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function dayStats(items) {
  const s = { total: items.length, pending: 0, delivered: 0, failed: 0, unsent: 0, awaiting: 0 };
  for (const it of items) {
    if (it.status === 'pending') s.pending++;
    else if (it.status === 'delivered') s.delivered++;
    else if (it.status === 'failed') s.failed++;
    if (it.status !== 'pending' && it.sendStatus !== 'sent') s.unsent++;
    if (it.sendStatus === 'awaiting') s.awaiting++;
  }
  return s;
}

/** Otros registros con el mismo número de paquete (excluye el propio). */
export function findPackageConflicts(items, pkg, selfId) {
  const p = cleanPackage(pkg).toLowerCase();
  if (!p) return [];
  return items.filter(it => it.id !== selfId && it.pkg && it.pkg.toLowerCase() === p && it.status !== 'pending');
}
