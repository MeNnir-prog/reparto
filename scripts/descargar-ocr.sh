#!/bin/sh
# OPCIONAL: descarga el motor OCR dentro de la carpeta de la app (vendor/tesseract),
# para no depender de cdn.jsdelivr.net. Ejecutar en una computadora con internet, desde la carpeta de la app:
#   sh scripts/descargar-ocr.sh
# y volver a publicar la carpeta. La app detecta sola la versión local.
set -e
V=5.1.1
D=vendor/tesseract
mkdir -p "$D/core" "$D/lang"
curl -fL -o "$D/tesseract.min.js" "https://cdn.jsdelivr.net/npm/tesseract.js@$V/dist/tesseract.min.js"
curl -fL -o "$D/worker.min.js"    "https://cdn.jsdelivr.net/npm/tesseract.js@$V/dist/worker.min.js"
for f in tesseract-core.wasm.js tesseract-core-simd.wasm.js tesseract-core-lstm.wasm.js tesseract-core-simd-lstm.wasm.js \
         tesseract-core-relaxedsimd.wasm.js tesseract-core-relaxedsimd-lstm.wasm.js; do
  curl -fL -o "$D/core/$f" "https://cdn.jsdelivr.net/npm/tesseract.js-core@$V/$f" || echo "(no existe $f, se omite)"
done
curl -fL -o "$D/lang/spa.traineddata.gz" "https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz"
echo "Listo: motor OCR guardado en $D"
