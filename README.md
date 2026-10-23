# Reparto · Reportes — PWA para iPhone

Aplicación web instalable (PWA) para reportar entregas por WhatsApp. Funciona en Safari para iPhone, sin App Store, sin cuenta de Apple Developer, sin servidor propio y sin credenciales de Meta.

---

## 1. Qué permite iOS y WhatsApp (análisis)

| Necesidad | ¿Se puede? | Cómo |
|---|---|---|
| Instalar sin App Store | Sí | Safari → Compartir → *Agregar a pantalla de inicio* |
| Cámara y galería | Sí | `<input type="file" accept="image/*" capture>` |
| Guardar datos entre aperturas | Sí | IndexedDB, dentro del iPhone |
| OCR en el teléfono | Sí | Tesseract.js (WebAssembly) en el propio iPhone |
| Abrir el chat de la tía con el texto escrito | Sí | Enlace oficial `whatsapp://send?phone=…&text=…` o `https://wa.me/…?text=…` |
| Enviar el mensaje sin tocar "Enviar" | **No** con WhatsApp normal | Solo con WhatsApp Business Platform (alternativa C) |
| Adjuntar la foto con un enlace | **No** | Los enlaces de WhatsApp solo aceptan texto |
| Pasar foto + texto a WhatsApp | Sí, con un toque del usuario | Web Share API (iOS 15+): menú Compartir de iOS |
| Elegir el contacto automáticamente al compartir | **No** | El menú Compartir no permite preseleccionar contacto |
| Saber si el mensaje se envió | **No** | Una web no puede ver qué pasa dentro de WhatsApp |

### Alternativa A — Enlace con mensaje precargado
- Abre directamente el chat de la tía con el texto ya escrito. El usuario solo toca **Enviar**.
- Abrir el chat **no es** enviar: por eso el reporte queda como *Pendiente de confirmar* hasta que el usuario confirma.
- No permite adjuntar fotos.
- Por defecto la app usa `whatsapp://` (lo abre iOS directamente, el texto no pasa por ningún servidor). `wa.me` queda como opción en Ajustes: si WhatsApp no intercepta el enlace, el texto viaja como parte de una URL hacia wa.me (HTTPS).

### Alternativa B — Compartir de iOS (Web Share API)
- Safari en iOS 15+ permite compartir archivos (`navigator.share({ files, text })`).
- El usuario elige WhatsApp → elige a la tía → Enviar. Son 3–4 toques.
- **Si WhatsApp conserva el texto junto con la foto depende de WhatsApp**, no de Safari, y puede cambiar entre versiones. Por eso la app además **copia el texto al portapapeles**: si no aparece, se mantiene apretado el campo de texto → *Pegar*.
- Alternativa en dos mensajes: "Enviar el texto (abre el chat)" + "Compartir solo la foto".
- Si el teléfono no soporta compartir archivos, la app muestra la foto para guardarla y abre el chat con el texto.

### Alternativa C — WhatsApp Business Platform (Cloud API)
- Permite envío 100 % automático **desde un servidor**, nunca desde el iPhone (el token de Meta no puede estar en el navegador).
- Necesita: cuenta de Meta Business (portafolio comercial), una app en Meta for Developers con el producto WhatsApp, una cuenta de WhatsApp Business (WABA), **un número de teléfono propio para el remitente** que no se use en la app normal de WhatsApp, verificación del nombre visible, un token permanente de usuario del sistema y un medio de pago para los mensajes cobrados.
- **Los mensajes saldrían de ese número de empresa**, no del WhatsApp de ustedes. El WhatsApp de la tía no cambia: los recibe como cualquier mensaje.
- **No registren el número personal del padre en la API**: un número registrado en Cloud API deja de funcionar en la app normal de WhatsApp (solo la app *WhatsApp Business* tiene un modo de "coexistencia"). La tía no tiene que migrar nada.
- Ventana de atención de 24 h: si la tía escribe al número de empresa, durante 24 h se pueden mandar mensajes libres (texto e imagen con leyenda) y esos son gratuitos. Fuera de esa ventana, solo se pueden mandar **plantillas aprobadas** por Meta (categoría *utility*), que se cobran por mensaje según el país del destinatario (Uruguay: tarifa "resto de América Latina", del orden de centavos de dólar por mensaje; revisen la tabla vigente de Meta antes de activarlo, cambia con frecuencia).
- Las plantillas tienen texto fijo con variables y las variables **no admiten saltos de línea**, por lo que el formato exacto de 3 líneas solo se respeta en mensajes libres (dentro de la ventana de 24 h) o diseñando la plantilla con 3 variables.
- Imágenes: soportadas (JPEG/PNG hasta 5 MB), con leyenda en mensajes libres o como encabezado de plantilla.
- Coste de infraestructura: un Cloudflare Worker gratuito alcanza.

### Decisión
**A + B, sin servidor**: es gratis, funciona hoy en el iPhone, usa el WhatsApp de ustedes y la tía recibe los mensajes del mismo número de siempre. El costo es un toque en "Enviar" (entregas) o 3–4 toques (no entregas con foto). La alternativa C queda **preparada pero apagada** (`opcional-cloud-api/worker.js` + Ajustes → Avanzado); faltan las credenciales de Meta, el número de empresa y la plantilla aprobada.

No se usa automatización no oficial, bots, ni ingeniería inversa de WhatsApp.

---

## 2. Arquitectura

```
iPhone (Safari / PWA)
 ├─ index.html, styles.css, app.js   Interfaz
 ├─ logic.js                          Reglas: cédula, mensajes, direcciones, OCR→tabla, duplicados
 ├─ db.js                             IndexedDB local (jornadas, direcciones, fotos, ajustes)
 ├─ ocr.js                            Tesseract.js en el teléfono + detección de la grilla de Excel
 └─ sw.js                             Funciona sin conexión (app y motor OCR en caché)
        │
        └── whatsapp://send …  /  Menú Compartir de iOS → WhatsApp (el usuario toca Enviar)
```
No hay backend. El hosting es estático y gratuito (GitHub Pages, Netlify o Cloudflare Pages).

### OCR: opciones evaluadas
| Opción | Privacidad | Costo | Calidad | Limitaciones |
|---|---|---|---|---|
| **Tesseract.js en el iPhone (usado)** | Las imágenes no salen del teléfono | Gratis | Buena en capturas nítidas | Descarga ~15 MB la primera vez; 5–20 s por captura; peor con fotos torcidas de una pantalla |
| **Texto en vivo de iOS (usado como alternativa)** | Local (Apple, en el dispositivo) | Gratis | Muy buena | Manual: Fotos → mantener apretado → Copiar → "Pegar texto" en la app |
| Google Vision / Azure / OpenAI | Las capturas con direcciones viajan a un tercero | Pago por imagen, requiere backend con clave | Excelente | Descartado: datos personales y necesidad de servidor |

Cómo lee la tabla:
1. **Grilla**: detecta líneas finas más oscuras *o más claras* que lo que las rodea (las planillas con filas pintadas de colores tienen líneas blancas), los cambios de color de fondo y los bordes de bandas rellenas. Las "filas" finitas sin contenido completo (líneas falsas) se unen a la vecina; los bloques de filas del mismo color sin línea divisoria se dividen según la altura típica de fila.
2. **Limpieza**: antes del OCR cada celda se divide por su propio color de fondo, así el texto queda negro sobre blanco en filas verdes, doradas, celestes, etc.
3. **Columnas por contenido**: pedido (`#1234`; corrige el "#" leído como "4" solo si la columna lo demuestra), empresa (texto corto que se repite), barrio (lista de barrios de Montevideo y alrededores), dirección (texto + número de puerta, más columnas de referencias). Números de fila de Excel, teléfonos y nombres se descartan. Tocando los chips se cambia qué es cada columna.
4. **Segunda pasada**: las celdas útiles vacías o dudosas se vuelven a leer de a una.

Cada fila muestra el recorte para comparar y avisos de lectura dudosa, falta de número de puerta o de pedido, o duplicados. **Nunca completa partes ilegibles**: lo que no se lee queda marcado para corregir.

Se guarda pedido, empresa, barrio, la dirección y el recorte de la dirección (no teléfonos ni nombres).

Prueba con una captura real (`tests/real/lista-colores.jpeg`, filas de colores): 22/22 filas con pedido, empresa, barrio y dirección correctos (antes: 5).

### Mapa y ruta optimizada
- **Mapa → Armar ruta optimizada**: ubica cada parada con Nominatim (OpenStreetMap), pide a OSRM la tabla de tiempos de manejo entre todas, calcula el orden en el teléfono (vecino más cercano + 2-opt) y dibuja el recorrido por calles. Sin OSRM, ordena en línea recta.
- Inicio: ubicación del teléfono, una dirección fija o la primera parada (Ajustes → Ruta y mapa).
- La búsqueda se limita a la ciudad configurada (+25 km) y, si hay barrio, descarta resultados a más de 4 km de él (calles con el mismo nombre en otro lado). Las que no aparecen se marcan a mano tocando el mapa.
- Cada parada tiene **Ir** (Google Maps / Waze) y hay un botón para navegar las próximas 10 seguidas en Google Maps.
- **Privacidad**: solo al tocar "Armar ruta" (con aviso la primera vez) se envían calle, número y barrio a OpenStreetMap. No se envían nombres, teléfonos, cédulas ni pedidos. Las búsquedas quedan en caché en el teléfono y se borran con la retención de jornadas.

---

## 3. Poner la app en internet (una sola vez, gratis)

Una PWA necesita estar en una dirección HTTPS. Opciones (eligen una):

**A) GitHub Pages** (recomendado, permanente)
1. Crear una cuenta gratis en github.com.
2. *New repository* → nombre `reparto` → **Public** → Create. (El código no tiene datos personales; los datos quedan en el iPhone.)
3. *Add file → Upload files* → arrastrar **todo el contenido** de esta carpeta (index.html, app.js, … y las carpetas icons, etc.) → *Commit*.
4. *Settings → Pages → Source: Deploy from a branch → main / (root)* → Save.
5. En 1–2 minutos queda en `https://SU-USUARIO.github.io/reparto/`.

**B) Netlify Drop**: entrar a app.netlify.com/drop, arrastrar la carpeta, crear cuenta gratis para que no se borre.

**C) Cloudflare Pages**: Workers & Pages → Create → Pages → Upload assets.

Para actualizar la app: subir los archivos nuevos al mismo lugar y cambiar `VERSION` en `sw.js`.

## 4. Instalar en el iPhone
1. Abrir la dirección en **Safari** (no en Chrome ni dentro de otra app).
2. Botón **Compartir** → **Agregar a pantalla de inicio** → Agregar.
3. Abrirla siempre desde el ícono **Reparto**.
4. Hacerlo en los dos iPhones (padre e hijo). Cada teléfono guarda sus propios datos.

## 5. Configurar (una vez)
1. **Ajustes** → Nombre: "Tía …", Número: su celular (ej. `099 123 456`; se guarda como +598…).
2. Tocar **Probar**: debe abrirse el chat de la tía con "Prueba de la app de reparto" (no hace falta enviarlo).
3. Si no abre, cambiar a "Enlace wa.me" y probar de nuevo.
4. (Opcional) **Crear jornada de prueba** para practicar con direcciones ficticias; después borrarla en Historial.
5. Con conexión, importar una captura una vez para que el motor OCR quede descargado.

## 6. Uso diario
1. **Importar** → *Elegir capturas* (se pueden elegir varias) o *Sacar foto*.
   - Si ya hay una jornada de otro día, se crea una **nueva** (la anterior queda en Historial, sin mezclarse; se puede marcar "Borrar la jornada anterior").
2. Revisar: las filas en **amarillo** son dudosas; compararlas con el recorte y corregir. Los duplicados se avisan pero no se borran: desmarcar solo los que sobren. *Importar N direcciones*.
3. En la puerta: **Reparto** → buscar por calle, número o referencia → tocar la dirección.
4. **✅ Entregado** → número de la etiqueta + cédula → *Revisar* → *Confirmar y enviar* → **Abrir WhatsApp** → Enviar → volver → **Sí, enviado**.
5. **❌ No entregado** → número, motivo, **foto** → *Revisar* → *Confirmar y enviar* → **Compartir foto + texto** → WhatsApp → la tía → (si falta el texto: Pegar) → Enviar → volver → **Sí, enviado**.
6. Si no hay señal o se deja para después: *Enviar más tarde*. Queda en **Sin enviar** (filtro en Reparto y lista en Historial, con contador rojo en la pestaña).

### Estados del envío
| Estado | Significado |
|---|---|
| Preparado, sin enviar | Reporte guardado, todavía no se abrió WhatsApp |
| Pendiente de confirmar | Se abrió WhatsApp/compartir; **no sabemos** si se envió |
| Enviado (confirmado) | El usuario confirmó que lo envió (o la API lo aceptó, si se activa) |
| No enviado / no confirmado | El usuario indicó que falló; se puede reintentar |

Reintentar usa el **mismo** registro (cuenta intentos), nunca crea un segundo reporte. Si un número de paquete ya figura en otro reporte de la jornada, la app avisa y pide confirmación. "Corregir reporte" y "Volver a pendiente" avisan si el mensaje ya se había enviado.

### Formato de los mensajes
```
#1567
Zum Felde 2190, apto 2
4567890-5
```
```
#2001
Camino Carrasco 7012
No se entregó porque el cliente no estaba en casa.
```
La cédula se acepta con o sin puntos/guion y se envía como `1234567-8`. Se valida el dígito verificador uruguayo; si no coincide, avisa (no corrige ni inventa).

---

## 7. Privacidad y seguridad
- **Dónde están los datos**: solo en el iPhone, en el almacenamiento de la app (IndexedDB). No hay servidor ni cuentas. Ni la app ni el hosting reciben direcciones, cédulas ni fotos.
- **Conservación**: las jornadas se borran solas a los 7 días (configurable: 1–30). Historial → *Borrar* jornada; Ajustes → *Borrar TODOS los datos*. Al pasar un reporte a "Entregado" o cambiar la foto, la foto anterior se borra.
- **Fotos**: se reducen a 1600 px y se re-codifican, lo que elimina los metadatos EXIF (incluida la ubicación GPS). Nunca se suben ni se generan enlaces públicos: viajan solo dentro de WhatsApp, cuando el usuario comparte.
- **URLs**: la app nunca pone datos en su propia URL. El único enlace con datos es el que se entrega a WhatsApp (`whatsapp://`, local).
- **Sin logs** con cédulas. Sin secretos en el código. El token de Meta (opcional) vive solo en el Worker.
- **Terceros**: el motor OCR se descarga de cdn.jsdelivr.net (versión fija 5.1.1). Para no depender de él, ejecutar `scripts/descargar-ocr.sh` y volver a publicar: la app usa la copia local automáticamente.
- **Limitaciones del almacenamiento local en iPhone**:
  - Cualquiera que desbloquee el teléfono puede abrir la app: usen código de bloqueo / Face ID. iOS cifra los datos con el bloqueo del teléfono, pero la app no tiene contraseña propia.
  - Si se borra el historial/datos de Safari, se borra la app o Safari elimina datos de sitios sin uso por semanas, **se pierden los datos**. La app pide almacenamiento persistente al importar.
  - Los datos no se sincronizan entre los dos iPhones.
  - Los mensajes enviados quedan en WhatsApp (y sus copias de seguridad) según la configuración de WhatsApp.

## 8. Sin conexión
- Funciona sin señal: abrir la app, buscar, reportar, sacar fotos, ver historial.
- El OCR funciona sin señal una vez descargado el motor (primer uso con internet). "Pegar texto" siempre funciona.
- WhatsApp guarda y envía los mensajes cuando vuelve la señal. La app no puede saberlo: confirmen "Sí, enviado" después de tocar Enviar en WhatsApp; si no, queda en "Sin enviar".

## 9. Activar la alternativa C (opcional)
1. Meta for Developers → crear app tipo *Business* → agregar WhatsApp → asociar un número de empresa (o usar el número de prueba para ensayar, con destinatarios verificados).
2. Crear un usuario del sistema con permiso `whatsapp_business_messaging` y generar un token permanente.
3. (Para escribir sin que la tía haya escrito en las últimas 24 h) crear y aprobar una plantilla *utility* con una variable `{{1}}` (y encabezado de imagen si se quiere la foto).
4. Cloudflare → Workers → crear Worker con `opcional-cloud-api/worker.js` y las variables indicadas en el archivo (`ALLOWED_TO` = número de la tía).
5. En la app: Ajustes → Avanzado → activar, pegar la URL del Worker y `APP_KEY`.
6. "Enviado (API)" significa **aceptado por Meta**, no leído. Si la API falla, sigue disponible el envío manual.

## Probar en la computadora (sin instalar nada)
En Windows, desde la carpeta del proyecto:
```
powershell -ExecutionPolicy Bypass -File scripts\servir-local.ps1
```
y abrir `http://localhost:8080`. (Con Node instalado también sirve cualquier servidor estático.)

## 10. Pruebas realizadas
- `node --test tests/unit.test.mjs` — 11 pruebas de lógica: cédula y dígito verificador, formato exacto de mensajes, motivos, referencias, duplicados, búsqueda, teléfono, OCR sin grilla.
- `tests/ocr_pipeline.py` + `tests/ocr_test.mjs` — dos capturas tipo Excel ficticias (`tests/fixture_lista*.png`) con celdas en varias líneas, columna de referencias, teléfonos y un duplicado: 12/12 filas correctas, la columna de dirección y la de referencias se eligen solas, duplicado y lecturas dudosas marcadas.
- `node tests/e2e.mjs` — recorrido completo en Chromium simulando un iPhone 13 (33 comprobaciones): importar, corregir, buscar, entregar, no entregar con foto, compartir, reintento, paquete repetido, API simulada, historial, persistencia, recuperación del formulario tras recargar y borrado.
- **No probado en un iPhone real** desde aquí (cámara, menú Compartir de iOS y apertura de WhatsApp): hay que verificarlo con la jornada de prueba. En las pruebas automáticas el OCR usó Tesseract de escritorio (inglés) en lugar de Tesseract.js (español), porque el entorno no tenía acceso al CDN.
