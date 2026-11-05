// Trabajador en segundo plano: todo el procesamiento pesado ocurre aquí para que
// la pantalla nunca se congele (detección, perspectiva, filtros y JPG).

import { detectDocument, defaultQuad, outputSize, warpPerspective, applyFilter, rotateImage } from './scan.js';

const DETECT_SIZE = 500;
// fotos de origen guardadas por clave, para no reenviarlas: { img, k } donde k = escala respecto al original
const sources = new Map();

/** Reduce una ImageData al lado mayor indicado (promedio por bloques, buena calidad). */
async function downscale(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return img;
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

/** Detecta la hoja; devuelve las esquinas en coordenadas de la imagen original, o null. */
async function detect(img) {
  const small = await downscale(img, DETECT_SIZE);
  const q = detectDocument(small);
  if (!q) return null;
  const k = img.width / small.width;
  // cada esquina un poco hacia adentro para no dejar bordes del fondo
  const pts = q.map((p) => ({ x: p.x * k, y: p.y * k }));
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  const inset = Math.hypot(img.width, img.height) * 0.007;
  return pts.map((p) => {
    const d = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / d) * inset, y: p.y + ((cy - p.y) / d) * inset };
  });
}

async function toJpeg(img, quality) {
  const oc = new OffscreenCanvas(img.width, img.height);
  oc.getContext('2d').putImageData(img, 0, 0);
  return oc.convertToBlob({ type: 'image/jpeg', quality });
}

async function render({ key, quad, filter, rotation = 0, maxSide = 2400, blobs = false }) {
  const stored = sources.get(key);
  if (!stored) throw new Error('Foto no disponible');
  const { img: src, k } = stored;
  quad = quad.map((p) => ({ x: p.x * k, y: p.y * k }));
  const size = outputSize(quad, maxSide, src.width, src.height);
  const warped = warpPerspective(src, quad, size.width, size.height);
  const out = rotateImage(applyFilter(warped, filter), rotation);
  if (!blobs) return { result: { image: out }, transfer: [out.data.buffer] };
  const blob = await toJpeg(out, 0.88);
  const thumb = await toJpeg(await downscale(out, 420), 0.8);
  return { result: { blob, thumb, width: out.width, height: out.height } };
}

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    let reply = { result: null, transfer: [] };
    switch (op) {
      case 'setSource': {
        // los trabajadores de vista previa guardan una copia más liviana
        const img = data.maxSide ? await downscale(data.image, data.maxSide) : data.image;
        sources.set(data.key, { img, k: img.width / data.image.width });
        reply.result = { width: data.image.width, height: data.image.height };
        break;
      }
      case 'dropSource':
        sources.delete(data.key);
        break;
      case 'detect': // imagen pequeña de la vista en vivo
        reply.result = { quad: detectDocument(data.image) };
        break;
      case 'detectSource': {
        const { img: src } = sources.get(data.key);
        const quad = await detect(src);
        reply.result = { quad, found: !!quad, fallback: quad ? null : defaultQuad(src.width, src.height, data.fullFrame ? 0 : 0.04) };
        break;
      }
      case 'render':
        reply = await render(data);
        break;
      default:
        throw new Error('Operación desconocida: ' + op);
    }
    self.postMessage({ id, ...reply.result }, reply.transfer || []);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
