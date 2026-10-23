# Uso: python3 ocr_pipeline.py imagen.png salida_prefijo  -> genera .gray (raw), .json (palabras)
import sys, json, subprocess, csv, io
from PIL import Image
img, out = sys.argv[1], sys.argv[2]
im = Image.open(img).convert('L'); im.save(out+'.pgm')
open(out+'.gray','wb').write(im.tobytes())
psm = sys.argv[3] if len(sys.argv)>3 else '11'
tsv = subprocess.run(['tesseract', img, '-', '--psm', psm, '-l', 'eng', 'tsv'], capture_output=True, text=True).stdout
words=[]
for r in csv.DictReader(io.StringIO(tsv), delimiter='\t', quoting=csv.QUOTE_NONE):
    if r['level']=='5' and r['text'].strip():
        x,y,w,h=int(r['left']),int(r['top']),int(r['width']),int(r['height'])
        words.append(dict(text=r['text'],conf=float(r['conf']),x0=x,y0=y,x1=x+w,y1=y+h))
json.dump(dict(width=im.width,height=im.height,words=words), open(out+'.json','w'), ensure_ascii=False)
print(len(words),'words')
