// Procesamiento de imagen del escáner: detectar la hoja, enderezar la perspectiva y filtros.
// Todo trabaja sobre objetos { data: Uint8ClampedArray RGBA, width, height } (ImageData).

/* ======================= utilidades ======================= */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function luminance(img) {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return out;
}

/** Desenfoque de caja separable (radio r), repetido `passes` veces ≈ gaussiano. */
function boxBlur(src, w, h, r, passes = 2) {
  const cur = Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const size = 2 * r + 1;
  const ix = (x) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const iy = (y) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += cur[row + ix(x)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / size;
        acc += cur[row + ix(x + r + 1)] - cur[row + ix(x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[iy(y) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = acc / size;
        acc += tmp[iy(y + r + 1) * w + x] - tmp[iy(y - r) * w + x];
      }
    }
  }
  return cur;
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i] | 0]++;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/* ======================= geometría ======================= */

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export const polygonArea = (q) => {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Ordena 4 puntos como arriba-izq, arriba-der, abajo-der, abajo-izq. */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted empieza cerca de -π (izquierda) y gira en sentido horario en pantalla
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => {
    const d = p.x + p.y;
    if (d < best) {
      best = d;
      start = i;
    }
  });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

/** Cuadrilátero de área máxima con vértices en el casco convexo. */
function maxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  const pick = (f) => hull.reduce((bi, p, i) => (f(p) > f(hull[bi]) ? i : bi), 0);
  let idx = [pick((p) => -(p.x + p.y)), pick((p) => p.x - p.y), pick((p) => p.x + p.y), pick((p) => p.y - p.x)];
  const area = (ids) => polygonArea(orderQuad(ids.map((i) => hull[i])));
  let best = area(idx);
  for (let iter = 0; iter < 6; iter++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < n; j++) {
        if (idx.includes(j)) continue;
        const trial = idx.slice();
        trial[k] = j;
        const a = area(trial);
        if (a > best + 1e-6) {
          best = a;
          idx = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return orderQuad(idx.map((i) => hull[i]));
}

const angleAt = (a, b, c) => {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

export const defaultQuad = (w, h, inset = 0.04) => [
  { x: w * inset, y: h * inset },
  { x: w * (1 - inset), y: h * inset },
  { x: w * (1 - inset), y: h * (1 - inset) },
  { x: w * inset, y: h * (1 - inset) },
];

/* ======================= detección de la hoja ======================= */

/**
 * Busca la hoja en una imagen pequeña (≈ 500 px de lado mayor).
 * Estrategia: la hoja suele ser la región clara más grande. Se umbraliza con Otsu,
 * se toma el componente conectado claro más grande, su casco convexo y el
 * cuadrilátero de área máxima dentro de él. Devuelve null si no hay algo confiable.
 */
export function detectDocument(img, debug = null) {
  const { width: w, height: h } = img;
  const lum = boxBlur(luminance(img), w, h, 2, 2);
  const t = otsu(lum);
  const total = w * h;

  // Luminancia poco suavizada: los bordes de la hoja quedan nítidos, las sombras siguen siendo suaves
  const sharp = boxBlur(luminance(img), w, h, 1, 1);

  /**
   * Hace crecer la región de la hoja hacia píxeles vecinos con cambio de brillo suave.
   * Así entra la parte de la hoja que está en sombra, pero se detiene en el borde
   * (donde el brillo salta de golpe al fondo).
   */
  const growRegion = (label, id, size, STEP) => {
    let sum = 0, cnt = 0;
    for (let i = 0; i < total; i += 7) if (label[i] === id) { sum += sharp[i]; cnt++; }
    const floor = (cnt ? sum / cnt : 128) * 0.3;
    const queue = new Int32Array(total);
    let head = 0, tail = 0;
    for (let i = 0; i < total; i++) if (label[i] === id) queue[tail++] = i;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, lp = sharp[p];
      const visit = (q) => {
        if (label[q] === id) return;
        const lq = sharp[q];
        if (lq < floor || Math.abs(lq - lp) > STEP) return;
        label[q] = id;
        queue[tail++] = q;
        size++;
      };
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < total - w) visit(p + w);
    }
    return size;
  };

  const tryThreshold = (thr, grow) => {
    const bright = new Uint8Array(total);
    for (let i = 0; i < total; i++) bright[i] = lum[i] > thr ? 1 : 0;
    // componentes conectados (4 vecinos) con pila
    const label = new Int32Array(total);
    let current = 0, bestLabel = 0, bestSize = 0;
    const stack = new Int32Array(total);
    for (let i = 0; i < total; i++) {
      if (!bright[i] || label[i]) continue;
      current++;
      let sp = 0, size = 0;
      stack[sp++] = i;
      label[i] = current;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && bright[p - 1] && !label[p - 1]) { label[p - 1] = current; stack[sp++] = p - 1; }
        if (x < w - 1 && bright[p + 1] && !label[p + 1]) { label[p + 1] = current; stack[sp++] = p + 1; }
        if (y > 0 && bright[p - w] && !label[p - w]) { label[p - w] = current; stack[sp++] = p - w; }
        if (y < h - 1 && bright[p + w] && !label[p + w]) { label[p + w] = current; stack[sp++] = p + w; }
      }
      if (size > bestSize) {
        bestSize = size;
        bestLabel = current;
      }
    }
    if (bestSize < total * 0.08) return null;
    const before = bestSize;
    const touchesBorder = () => {
      for (let x = 0; x < w; x++) if (label[x] === bestLabel || label[(h - 1) * w + x] === bestLabel) return true;
      for (let y = 0; y < h; y++) if (label[y * w] === bestLabel || label[y * w + w - 1] === bestLabel) return true;
      return false;
    };
    if (grow) {
      const wasTouching = touchesBorder();
      bestSize = growRegion(label, bestLabel, bestSize, grow);
      // si al crecer llegó al borde de la foto, se escapó hacia el fondo: se descarta
      if (!wasTouching && touchesBorder()) return null;
      if (bestSize > before * 1.6) return null;
    }
    const info = debug ? { thr, grow, before, after: bestSize } : null;
    if (info) debug.push(info);

    // bordes izquierdo/derecho por fila -> casco convexo
    const pts = [];
    for (let y = 0; y < h; y++) {
      let minX = -1, maxX = -1;
      for (let x = 0; x < w; x++) {
        if (label[y * w + x] === bestLabel) {
          if (minX < 0) minX = x;
          maxX = x;
        }
      }
      if (minX >= 0) pts.push({ x: minX, y }, { x: maxX + 1, y });
    }
    const hull = convexHull(pts);
    const quad = maxAreaQuad(hull);
    if (!quad) return null;

    const qArea = polygonArea(quad);
    const hullArea = polygonArea(hull);
    // la región debe parecerse a un cuadrilátero y el cuadrilátero debe ser razonable
    if (info) Object.assign(info, { quad: quad.map((p) => [Math.round(p.x), Math.round(p.y)]), qArea: Math.round(qArea), hullRatio: +(qArea / hullArea).toFixed(3), fill: +(bestSize / qArea).toFixed(3) });
    if (qArea < total * 0.08 || qArea / hullArea < 0.85 || bestSize / qArea < 0.6) return null;
    for (let i = 0; i < 4; i++) {
      const ang = angleAt(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]);
      if (ang < 40 || ang > 140) return null;
    }
    // si ocupa toda la foto probablemente no se encontró borde
    const touchesAll = quad.every((p) => p.x < 3 || p.y < 3 || p.x > w - 4 || p.y > h - 4);
    if (touchesAll && qArea > total * 0.97) return null;
    // qué tan rectangular es: el cuadrilátero llena el casco y la región llena el cuadrilátero
    const fill = bestSize / qArea;
    const score = (qArea / hullArea) * Math.min(fill, 1 / fill);
    if (info) info.score = +score.toFixed(3);
    return { quad, score };
  };

  const candidates = [];
  for (const thr of [t, t + 15, t - 15, t + 30]) {
    if (thr <= 20 || thr >= 240) continue;
    for (const grow of [3.5, 2.2, 0]) {
      const c = tryThreshold(thr, grow);
      if (c) candidates.push({ ...c, area: polygonArea(c.quad) });
    }
  }
  if (!candidates.length) return null;
  // la más rectangular; ante empate (±4 %), la de mayor área (incluye las sombras)
  const bestScore = Math.max(...candidates.map((c) => c.score));
  const good = candidates.filter((c) => c.score >= bestScore - 0.04);
  good.sort((a, b) => b.area - a.area);
  return good[0].quad;
}

/* ======================= perspectiva ======================= */

/** Resuelve el sistema lineal A·x = b (eliminación gaussiana con pivoteo). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Homografía que lleva los puntos `from` a `to` (4 parejas). */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

/**
 * Proporción real (ancho/alto) de la hoja fotografiada en perspectiva.
 * Método de Zhang y He: estima la distancia focal a partir de las 4 esquinas
 * suponiendo el centro óptico en el centro de la foto.
 */
function trueAspect(quad, imgW, imgH) {
  const c = (p) => [p.x - imgW / 2, p.y - imgH / 2, 1];
  const [m1, m2, m4, m3] = [c(quad[0]), c(quad[1]), c(quad[2]), c(quad[3])]; // TL, TR, BR, BL
  const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const m14 = crossV(m1, m4);
  const k2 = dot(m14, m3) / dot(crossV(m2, m4), m3);
  const k3 = dot(m14, m2) / dot(crossV(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  if (!(f2 > 0) || !isFinite(f2)) return null;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  return isFinite(r) && r > 0 ? r : null;
}

const PAPER_RATIOS = [1 / Math.SQRT2, 8.5 / 11, 8.5 / 13, 8.5 / 14]; // A4, carta, oficio, legal (vertical)

/** Tamaño de salida para un cuadrilátero, con la proporción real de la hoja. */
export function outputSize(quad, maxSide = 2400, imgW = 0, imgH = 0) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
  let h = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
  const measured = w / h;
  let ratio = imgW ? trueAspect(quad, imgW, imgH) : null;
  // si la estimación es poco creíble se usa la medida directa
  if (!ratio || ratio / measured > 1.6 || measured / ratio > 1.6) ratio = measured;
  // si se parece mucho a un tamaño de papel común, se ajusta exacto
  for (const base of PAPER_RATIOS) {
    for (const pr of [base, 1 / base]) if (Math.abs(ratio / pr - 1) < 0.045) ratio = pr;
  }
  const longSide = Math.max(w, h);
  if (ratio <= 1) { h = longSide; w = h * ratio; } else { w = longSide; h = w / ratio; }
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Endereza la hoja: devuelve una ImageData nueva de outW×outH. */
export function warpPerspective(src, quad, outW, outH) {
  const dst = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const H = homography(dst, quad); // de salida -> origen
  const out = new ImageData(outW, outH);
  const o = out.data, s = src.data, sw = src.width, sh = src.height;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H;
  for (let v = 0; v < outH; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5;
      const z = h6 * uu + h7 * vv + 1;
      let x = (h0 * uu + h1 * vv + h2) / z - 0.5;
      let y = (h3 * uu + h4 * vv + h5) / z - 0.5;
      if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
      if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const oi = (v * outW + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * fx;
        const bot = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * fx;
        o[oi + c] = top + (bot - top) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  return out;
}

/* ======================= filtros ======================= */

/** Máximo (o mínimo) en ventana deslizante, separable. */
function rankFilter(src, w, h, r, useMax) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pick = useMax ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]);
      tmp[y * w + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Estima el color del papel en cada punto (la iluminación) para quitar sombras.
 * Se trabaja en una copia pequeña: un "cierre" morfológico (máximo y luego mínimo)
 * borra los trazos finos de la tinta pero conserva la forma de las sombras.
 */
function paperBackground(img) {
  const { data, width: w, height: h } = img;
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 320));
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  const ch = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = gy * f; y < Math.min(h, gy * f + f); y++) {
        for (let x = gx * f; x < Math.min(w, gx * f + f); x++) {
          const i = (y * w + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const gi = gy * gw + gx;
      ch[0][gi] = r / n; ch[1][gi] = g / n; ch[2][gi] = b / n;
    }
  }
  // radio ≈ 1,2 % del lado mayor: más ancho que una letra, más fino que una sombra
  const rad = Math.max(3, Math.round(Math.max(gw, gh) * 0.012));
  const bg = ch.map((c) => boxBlur(rankFilter(rankFilter(c, gw, gh, rad, true), gw, gh, rad, false), gw, gh, 2, 2));

  // Zonas muy oscuras (fotos, bloques negros) no son sombra: se rellenan con el papel vecino
  const L = new Float32Array(gw * gh);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * bg[0][i] + 0.587 * bg[1][i] + 0.114 * bg[2][i];
  const sorted = Array.from(L).sort((a, b) => a - b);
  const paperLevel = sorted[Math.floor(sorted.length * 0.9)] || 255;
  const minLevel = paperLevel * 0.3;
  for (let pass = 0; pass < 40; pass++) {
    let changed = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (L[i] >= minLevel) continue;
        let best = -1;
        if (x > 0 && L[i - 1] >= minLevel) best = i - 1;
        else if (x < gw - 1 && L[i + 1] >= minLevel) best = i + 1;
        else if (y > 0 && L[i - gw] >= minLevel) best = i - gw;
        else if (y < gh - 1 && L[i + gw] >= minLevel) best = i + gw;
        if (best < 0) continue;
        for (let c = 0; c < 3; c++) bg[c][i] = bg[c][best];
        L[i] = L[best];
        changed++;
      }
    }
    if (!changed) break;
  }
  return { bg, gw, gh, f };
}

/** Quita sombras y deja el papel blanco conservando el color de la tinta. */
function normalizeLighting(img) {
  const { data, width: w, height: h } = img;
  const { bg, gw, gh, f } = paperBackground(img);
  const out = new ImageData(w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    let gy = (y + 0.5) / f - 0.5;
    gy = gy < 0 ? 0 : gy > gh - 1 ? gh - 1 : gy;
    const gy0 = gy | 0, gy1 = Math.min(gh - 1, gy0 + 1), fy = gy - gy0;
    for (let x = 0; x < w; x++) {
      let gx = (x + 0.5) / f - 0.5;
      gx = gx < 0 ? 0 : gx > gw - 1 ? gw - 1 : gx;
      const gx0 = gx | 0, gx1 = Math.min(gw - 1, gx0 + 1), fx = gx - gx0;
      const i = (y * w + x) * 4;
      const a = gy0 * gw + gx0, b = gy0 * gw + gx1, cc = gy1 * gw + gx0, d = gy1 * gw + gx1;
      for (let c = 0; c < 3; c++) {
        const B = bg[c];
        const top = B[a] + (B[b] - B[a]) * fx, bot = B[cc] + (B[d] - B[cc]) * fx;
        const background = Math.max(top + (bot - top) * fy, 8);
        o[i + c] = clamp255((data[i + c] / background) * 255);
      }
      o[i + 3] = 255;
    }
  }
  return out;
}

/** Curva de niveles: oscuros más negros y papel blanco puro. */
function levels(v, black, white) {
  const t = (v - black) / (white - black);
  return t <= 0 ? 0 : t >= 1 ? 255 : 255 * Math.pow(t, 1.15);
}

export const FILTERS = [
  { id: 'mejorado', label: 'Mejorado' },
  { id: 'bn', label: 'Blanco y negro' },
  { id: 'gris', label: 'Grises' },
  { id: 'original', label: 'Original' },
];

const lut = (fn) => {
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) t[v] = fn(v);
  return t;
};
const LUT_COLOR = lut((v) => levels(v, 28, 238));
const LUT_GRAY = lut((v) => levels(v, 30, 236));
// umbral suave: bordes de letra nítidos pero sin dientes
const LUT_BW = lut((v) => {
  const t = (v - 150) / 40;
  return t <= 0 ? 0 : t >= 1 ? 255 : 255 * t * t * (3 - 2 * t);
});

export function applyFilter(img, filter) {
  if (filter === 'original') return img;
  const norm = normalizeLighting(img);
  const d = norm.data;
  const n = d.length;
  if (filter === 'mejorado') {
    for (let i = 0; i < n; i += 4) {
      const r = LUT_COLOR[d[i]], g = LUT_COLOR[d[i + 1]], b = LUT_COLOR[d[i + 2]];
      // un poco más de saturación para que la tinta de color se vea viva
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = l + (r - l) * 1.25;
      d[i + 1] = l + (g - l) * 1.25;
      d[i + 2] = l + (b - l) * 1.25;
    }
  } else {
    const table = filter === 'bn' ? LUT_BW : LUT_GRAY;
    for (let i = 0; i < n; i += 4) {
      const v = table[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return norm;
}

/** Gira una ImageData en múltiplos de 90° (sentido horario). */
export function rotateImage(img, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (!q) return img;
  const { width: w, height: h, data } = img;
  const ow = q % 2 ? h : w, oh = q % 2 ? w : h;
  const out = new ImageData(ow, oh);
  const o = new Uint32Array(out.data.buffer), s = new Uint32Array(data.buffer, data.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (q === 1) { nx = h - 1 - y; ny = x; }
      else if (q === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      o[ny * ow + nx] = s[y * w + x];
    }
  }
  return out;
}
