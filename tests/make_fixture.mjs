import { chromium } from 'playwright';
const rows = [
 ['1','Zum Felde 2190','casa','Malvín','099 123 456'],
 ['2','Zum Felde 2190','apto 2','Malvín','098 765 432'],
 ['3','Av. 8 de Octubre 3456','','La Blanqueada','091 222 333'],
 ['4','Calle Rivera 1234','apto 501, torre B','Pocitos','094 555 666'],
 ['5','José Batlle y Ordóñez 5678','unidad habitacional, bloque 3','Unión','092 111 000'],
 ['6','Camino Carrasco 7012','','Carrasco','099 000 111'],
 ['7','Libertad 2741 piso 4','','Pocitos','093 444 222'],
 ['8','Bv. Artigas 1100','','Tres Cruces','097 333 888'],
 ['9','Zum Felde 2190','casa','Malvín','099 123 456'],
 ['10','Gral. Flores 4501 bis','esq. Propios','Goes','095 999 777'],
];
const html = `<html><body style="margin:0;background:#fff;font-family:Calibri,Arial,sans-serif">
<table style="border-collapse:collapse;font-size:15px">
<tr style="background:#e8e8e8">${['N°','Dirección','Referencia','Barrio','Teléfono'].map(h=>`<th style="border:1px solid #c8c8c8;padding:3px 8px;text-align:left">${h}</th>`).join('')}</tr>
${rows.map(r=>`<tr>${r.map((c,i)=>`<td style="border:1px solid #d4d4d4;padding:3px 8px;${i==0?'text-align:right':''}">${c}</td>`).join('')}</tr>`).join('')}
</table></body></html>`;
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:390,height:500},deviceScaleFactor:3});
await p.setContent(html); await p.screenshot({path:'fixture_lista.png'}); 
// segunda captura (continuación, con 1 fila solapada)
const rows2=[rows[9],['11','Ellauri 350','apto 1201','Punta Carretas','096 123 789'],['12','Larrañaga 3333','','La Blanqueada','099 777 666']];
await p.setContent(html.replace(/<tr>.*<\/tr>\n?<\/table>/s, rows2.map(r=>`<tr>${r.map((c,i)=>`<td style="border:1px solid #d4d4d4;padding:3px 8px">${c}</td>`).join('')}</tr>`).join('')+'</table>'));
await p.screenshot({path:'fixture_lista2.png'});
await b.close();
