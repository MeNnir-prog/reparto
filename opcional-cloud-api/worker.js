// OPCIONAL — Servidor mínimo para enviar reportes con WhatsApp Business Platform (Cloud API).
// NO es necesario para usar la app. Pensado para Cloudflare Workers (plan gratuito).
//
// Variables (Settings → Variables, como "secret"):
//   WA_TOKEN            Token permanente de un usuario del sistema de Meta (NUNCA va en el iPhone)
//   WA_PHONE_NUMBER_ID  ID del número de WhatsApp Business (no es el número de teléfono)
//   APP_KEY             Clave larga aleatoria; se pega en Ajustes → Avanzado de la app
//   ALLOWED_TO          Número permitido como destino (ej. 59899123456). Evita usos indebidos.
//   ALLOWED_ORIGIN      URL donde está publicada la app (ej. https://usuario.github.io)
//   TEMPLATE_NAME       (opcional) plantilla "utility" aprobada, con 1 variable {{1}} en el cuerpo.
//                       Si está definida, se usa siempre (necesario fuera de la ventana de 24 h).
//   TEMPLATE_LANG       (opcional) idioma de la plantilla, por defecto "es"
//   GRAPH_VERSION       (opcional) versión de la Graph API, por defecto "v23.0"
//
// Privacidad: este servidor no guarda nada ni escribe el contenido en logs.

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (req.headers.get('Authorization') !== `Bearer ${env.APP_KEY}`) return json({ ok: false, error: 'unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
    const to = String(body.to || '').replace(/\D/g, '');
    if (!to || to !== String(env.ALLOWED_TO)) return json({ ok: false, error: 'destino no permitido' }, 403);
    const text = String(body.text || '').slice(0, 1000);
    const graph = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}/${env.WA_PHONE_NUMBER_ID}`;
    const auth = { Authorization: `Bearer ${env.WA_TOKEN}` };

    try {
      let mediaId = null;
      if (body.imageBase64) {
        const bin = Uint8Array.from(atob(body.imageBase64), c => c.charCodeAt(0));
        if (bin.length > 5 * 1024 * 1024) return json({ ok: false, error: 'imagen > 5 MB' }, 413);
        const fd = new FormData();
        fd.append('messaging_product', 'whatsapp');
        fd.append('type', 'image/jpeg');
        fd.append('file', new Blob([bin], { type: 'image/jpeg' }), 'evidencia.jpg');
        const up = await fetch(`${graph}/media`, { method: 'POST', headers: auth, body: fd });
        const uj = await up.json();
        if (!up.ok || !uj.id) return json({ ok: false, error: 'media: ' + (uj.error?.message || up.status) }, 502);
        mediaId = uj.id;
      }

      let payload;
      if (env.TEMPLATE_NAME) {
        // Las variables de plantilla no admiten saltos de línea: se reemplazan por " · ".
        const components = [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' · ') }] }];
        if (mediaId) components.unshift({ type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] });
        payload = { messaging_product: 'whatsapp', to, type: 'template', template: { name: env.TEMPLATE_NAME, language: { code: env.TEMPLATE_LANG || 'es' }, components } };
      } else if (mediaId) {
        payload = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption: text } };
      } else {
        payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } };
      }
      const r = await fetch(`${graph}/messages`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok || !j.messages?.[0]?.id) return json({ ok: false, error: j.error?.message || String(r.status) }, 502);
      // "Aceptado" por Meta: no garantiza que haya sido entregado/leído (eso llega por webhook).
      return json({ ok: true, messageId: j.messages[0].id });
    } catch (e) {
      return json({ ok: false, error: 'error de conexión con Meta' }, 502);
    }
  }
};
