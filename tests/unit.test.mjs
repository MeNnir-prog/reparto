import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

test('cédula: formatos aceptados y dígito verificador', () => {
  // 1234567-2 es válida según el algoritmo (2*1+9*2+8*3+7*4+6*5+3*6+4*7 = 148 -> 10-8 = 2)
  assert.deepEqual(L.parseCedula('1.234.567-2'), { ok: true, formatted: '1234567-2', validDigit: true, error: '' });
  assert.equal(L.parseCedula('12345672').formatted, '1234567-2');
  assert.equal(L.parseCedula('1234567 2').formatted, '1234567-2');
  assert.equal(L.parseCedula('4567890-3').ok, true);          // formato correcto
  assert.equal(L.parseCedula('4567890-3').validDigit, false); // pero el verificador no coincide (es del ejemplo)
  assert.equal(L.parseCedula('4567890-5').validDigit, true);
  assert.equal(L.parseCedula('123456-7').formatted, '123456-7'); // cédulas de 6+1 dígitos
  assert.equal(L.parseCedula('12345').ok, false);
  assert.equal(L.parseCedula('').ok, false);
  assert.equal(L.parseCedula('12a4567-2').ok, false);
});

test('mensaje de entrega: formato exacto', () => {
  assert.equal(L.buildDeliveredMessage({ pkg: '#1567', address: '8 de octubre', cedula: '4567890-3' }), '#1567\n8 de octubre\n4567890-3');
});

test('mensaje de no entrega: refleja el motivo elegido', () => {
  assert.equal(L.buildFailedMessage({ pkg: '1567', address: '8 de octubre', reasonCode: 'ausente' }), '#1567\n8 de octubre\nNo se entregó porque el cliente no estaba en casa.');
  assert.match(L.buildFailedMessage({ pkg: '1', address: 'x 1', reasonCode: 'rechaza' }), /rechazó el paquete\.$/);
  assert.equal(L.reasonSentence('otro', 'El portero no dejó entrar'), 'No se entregó porque el portero no dejó entrar.');
  assert.equal(L.reasonSentence('otro', 'no se entregó por lluvia fuerte'), 'No se entregó por lluvia fuerte.');
  assert.equal(L.reasonSentence('otro', '   '), '');
  const all = new Set(L.REASONS.filter(r => r.sentence).map(r => r.sentence));
  assert.equal(all.size, 5);
});

test('referencias de dirección', () => {
  assert.deepEqual(L.splitAddress('Zum Felde 2190, casa'), { address: 'Zum Felde 2190', refs: 'casa' });
  assert.deepEqual(L.splitAddress('Zum Felde 2190 apto 2'), { address: 'Zum Felde 2190', refs: 'apto 2' });
  assert.deepEqual(L.splitAddress('Calle Y 5678, unidad habitacional'), { address: 'Calle Y 5678', refs: 'unidad habitacional' });
  assert.deepEqual(L.splitAddress('Av. 8 de Octubre 3456'), { address: 'Av. 8 de Octubre 3456', refs: '' });
  assert.deepEqual(L.splitAddress('Casavalle 123'), { address: 'Casavalle 123', refs: '' });
  assert.deepEqual(L.splitAddress('Torre de los Profesionales 100'), { address: 'Torre de los Profesionales 100', refs: '' });
  assert.equal(L.fullAddress({ address: 'Zum Felde 2190', refs: 'casa' }), 'Zum Felde 2190, casa');
});

test('duplicados: se marcan, no se eliminan', () => {
  const rows = L.markDuplicates([{ text: 'Zum Felde 2190, casa' }, { text: 'Zum Felde 2190, apto 2' }, { text: 'zum felde 2190 casa' }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].dupRows, [2]);
  assert.deepEqual(rows[0].similarRows, [1]);
  assert.deepEqual(rows[1].dupRows, []);
});

test('teléfono y enlace de WhatsApp (sin datos en la URL de la app)', () => {
  assert.equal(L.normalizePhone('099 123 456'), '59899123456');
  assert.equal(L.normalizePhone('+598 99 123 456'), '59899123456');
  assert.equal(L.whatsappUrl('59899123456', '#1\nA 1\n1-1'), 'whatsapp://send?phone=59899123456&text=%231%0AA%201%0A1-1');
  assert.equal(L.whatsappUrl('59899123456', 'x', 'web'), 'https://wa.me/59899123456?text=x');
});

test('búsqueda por calle, número y referencia', () => {
  const it = { address: 'Zum Felde 2190', refs: 'apto 2', original: '' };
  assert.ok(L.matchesQuery(it, '2190'));
  assert.ok(L.matchesQuery(it, 'zum apto'));
  assert.ok(!L.matchesQuery(it, 'casa'));
  assert.ok(L.matchesQuery({ address: 'José Batlle y Ordóñez 5678', refs: '' }, 'ordonez'));
});

test('paquete repetido', () => {
  const items = [{ id: 'a', pkg: '1567', status: 'delivered' }, { id: 'b', pkg: '', status: 'pending' }];
  assert.equal(L.findPackageConflicts(items, '#1567', 'b').length, 1);
  assert.equal(L.findPackageConflicts(items, '1567', 'a').length, 0);
  assert.equal(L.validatePackage(' #1567 ').value, '1567');
  assert.equal(L.validatePackage('').ok, false);
});

test('estadísticas de jornada', () => {
  const s = L.dayStats([{ status: 'pending' }, { status: 'delivered', sendStatus: 'sent' }, { status: 'failed', sendStatus: 'awaiting' }]);
  assert.deepEqual(s, { total: 3, pending: 1, delivered: 1, failed: 1, unsent: 1, awaiting: 1 });
});

test('texto pegado (Texto en vivo)', () => {
  const r = L.rowsFromText('Dirección\nZum Felde 2190, casa\n\nCalle sin numero\n');
  assert.equal(r.length, 2);
  assert.equal(r[1].lowConf, true);
});

test('referencia antes de la calle y paréntesis', () => {
  assert.deepEqual(L.splitAddress('Casa, General Maximo Tajes 7405'), { address: 'General Maximo Tajes 7405', refs: 'Casa' });
  assert.deepEqual(L.splitAddress('Oficina, Cambara 1615. (De 9 a13 y 14 a 18)'), { address: 'Cambara 1615.', refs: 'Oficina, De 9 a13 y 14 a 18' });
});

test('pedido: "#" leído como "4" se corrige solo si la columna lo demuestra', () => {
  const f = L.orderFixer(['#1162', '41609', '*2099', '+ 1908']);
  assert.deepEqual(['#1162', '41609', '*2099', '+ 1908'].map(t => f(t).value), ['1162', '1609', '2099', '1908']);
  const g = L.orderFixer(['41162', '41609', '42099']); // ninguna con "#", todas empiezan con 4 y miden igual
  assert.equal(g('41162').value, '1162');
  const h = L.orderFixer(['1162', '41609', '2099']); // largos distintos: no se toca
  assert.equal(h('41609').value, '41609');
});

test('columnas: pedido, empresa, barrio y dirección por contenido', () => {
  const col = (index, texts, x0) => ({ index, texts, x0, x1: x0 + 50, title: '', filled: texts.length,
    score: texts.reduce((s, t) => s + L.addressScore(t), 0) / texts.length,
    refShare: 0 });
  const roles = L.classifyColumns([
    col(0, ['15', '16', '17'], 0), col(1, ['Aquora', 'Garden', 'Garden'], 60), col(2, ['#1162', '#1609', '42099'], 120),
    col(3, ['93326278', '94460590', '95719997'], 180), col(4, ['malvin', 'carrasco', 'punta gorda'], 240),
    col(5, ['Missouri 1504', 'Lieja 7167', 'Fedra 6467'], 300), col(6, ['Maria González', 'Daniela Peisino', 'Susana Silva'], 360)
  ]);
  assert.deepEqual(roles, { 0: 'none', 1: 'company', 2: 'order', 3: 'none', 4: 'zone', 5: 'address', 6: 'none' });
});

test('mapa: calle y número para buscar', () => {
  assert.deepEqual(L.geoParts('Av Gral Rivera 4221'), { street: 'Avenida General Rivera', number: '4221' });
  assert.deepEqual(L.geoParts('Punta Gorda, Caramuru 5925'), { street: 'Caramuru', number: '5925' });
  assert.deepEqual(L.geoParts('Dr. Andres Puyol 1643'), { street: 'Doctor Andres Puyol', number: '1643' });
  assert.deepEqual(L.geoParts('Av. 8 de Octubre 3456'), { street: 'Avenida 8 de Octubre', number: '3456' });
});

test('ruta: el orden no da vueltas de más', () => {
  // Puntos sobre una línea, desordenados: desde el inicio en 0 hay que ir 1,2,3,4
  const p = x => ({ lat: -34.9, lng: -56.2 + x * 0.01 });
  const pts = [p(3), p(1), p(4), p(2)];
  assert.deepEqual(L.optimizeOrder(pts, p(0)).map(i => pts[i]), [p(1), p(2), p(3), p(4)]);
});

test('texto pegado con número de pedido', () => {
  const r = L.rowsFromText('#1162 Missouri 1504, Montevideo');
  assert.equal(r[0].orderNo, '1162');
  assert.equal(r[0].text, 'Missouri 1504, Montevideo');
});

test('columnas sin grilla (fallback por espacios)', () => {
  // Simula palabras de una tabla sin líneas: Nº | Dirección | Teléfono
  const W = (t, x, y) => ({ text: t, conf: 95, x0: x, y0: y, x1: x + t.length * 12, y1: y + 20 });
  const words = [];
  const data = [['1', 'Zum Felde 2190', '099123456'], ['2', 'Rivera 1234', '098111222'], ['3', 'Ellauri 350 apto 1', '091000111']];
  data.forEach((r, i) => {
    const y = 40 + i * 40;
    words.push(W(r[0], 10, y));
    let x = 80; for (const w of r[1].split(' ')) { words.push(W(w, x, y)); x += w.length * 12 + 8; }
    words.push(W(r[2], 400, y));
  });
  const a = L.analyzeTable(words);
  const rows = L.buildRows(a, a.selected);
  assert.deepEqual(rows.map(r => r.text), ['Zum Felde 2190', 'Rivera 1234', 'Ellauri 350 apto 1']);
});
