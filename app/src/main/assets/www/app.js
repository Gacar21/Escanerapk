import { detectDocument, defaultQuad, outputSize, warpPerspective, applyFilter, rotateImage, FILTERS } from './scan.js';
import * as store from './store.js';

const native = window.Android || null;
const $ = (id) => document.getElementById(id);

const MAX_SOURCE = 3000;   // lado mayor de la foto con la que se trabaja
const DETECT_SIZE = 500;   // lado mayor para detectar la hoja
const MAX_OUTPUT = 2400;   // lado mayor de la página escaneada (≈ 290 ppp en A4)
const JPEG_QUALITY = 0.88;
const FILTER_KEY = 'escaner.filtro';

let filterPref = 'mejorado';
try { filterPref = localStorage.getItem(FILTER_KEY) || 'mejorado'; } catch { /* sin almacenamiento */ }

/* =================== utilidades de interfaz =================== */

const SCREENS = ['home', 'crop', 'enhance', 'doc'];
const show = (id) => SCREENS.forEach((s) => ($(s).hidden = s !== id));
const current = () => SCREENS.find((s) => !$(s).hidden);

let toastTimer;
const toast = (msg) => {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
};

const busy = (text) => {
  $('busyOverlay').hidden = text === null;
  if (text !== null) $('busyText').textContent = text;
};

let dialogResolve = null;
const ask = (title, ok = 'Aceptar', cancel = 'Cancelar') =>
  new Promise((resolve) => {
    $('dialogTitle').textContent = title;
    $('dialogOk').textContent = ok;
    $('dialogCancel').textContent = cancel;
    $('dialogCancel').hidden = !cancel;
    $('dialog').hidden = false;
    dialogResolve = resolve;
  });
const closeDialog = (value) => {
  $('dialog').hidden = true;
  const r = dialogResolve;
  dialogResolve = null;
  r && r(value);
};
$('dialogForm').addEventListener('submit', (e) => {
  e.preventDefault();
  closeDialog(true);
});
$('dialogCancel').addEventListener('click', () => closeDialog(false));

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const formatDate = (ts) =>
  new Date(ts).toLocaleString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const defaultName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Escaneo ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}.${p(d.getMinutes())}`;
};

const safeName = (name) => (name || 'Escaneo').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Escaneo';

/* =================== imágenes =================== */

const blobToCanvas = (blob, maxSide = Infinity) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });

const canvasToBlob = (canvas, type = 'image/jpeg', quality = JPEG_QUALITY) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const scaled = (canvas, maxSide) => {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
};

const imageDataToCanvas = (img) => {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
};

const canvasData = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);

const rotateCanvas = (canvas, quarterTurns) => {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (!q) return canvas;
  const c = document.createElement('canvas');
  c.width = q % 2 ? canvas.height : canvas.width;
  c.height = q % 2 ? canvas.width : canvas.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return c;
};

/** Busca la hoja en la foto; si no la encuentra devuelve null. */
function autoQuad(canvas) {
  const small = scaled(canvas, DETECT_SIZE);
  const q = detectDocument(canvasData(small));
  if (!q) return null;
  const k = canvas.width / small.width;
  // se mete cada esquina un poco hacia el centro para no dejar bordes del fondo
  const pts = q.map((p) => ({ x: p.x * k, y: p.y * k }));
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const inset = Math.hypot(canvas.width, canvas.height) * 0.007;
  return pts.map((p) => {
    const d = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / d) * inset, y: p.y + ((cy - p.y) / d) * inset };
  });
}

/** Endereza y aplica el filtro; devuelve un canvas con la página final. */
function renderPage(srcCanvas, quad, filter, rotation, maxSide = MAX_OUTPUT) {
  const size = outputSize(quad, maxSide, srcCanvas.width, srcCanvas.height);
  const warped = warpPerspective(canvasData(srcCanvas), quad, size.width, size.height);
  return imageDataToCanvas(rotateImage(applyFilter(warped, filter), rotation));
}

/* =================== edición de una página =================== */

let edit = null; // { doc, page, canvas, srcBlob, quad, detected, rotation, filter, warped, filtered }
let captureTarget = null; // documento al que se agregan las páginas nuevas

function startCapture(doc = null) {
  captureTarget = doc;
  $('camInput').click();
}

function startImport(doc = null) {
  captureTarget = doc;
  $('galleryInput').click();
}

async function prepareSource(blob) {
  const canvas = await blobToCanvas(blob, MAX_SOURCE);
  // la copia guardada ya queda derecha (sin depender de la orientación EXIF)
  const srcBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { canvas, srcBlob };
}

$('camInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  busy('Preparando la foto…');
  try {
    await nextFrame();
    const { canvas, srcBlob } = await prepareSource(file);
    const detected = autoQuad(canvas);
    edit = {
      doc: captureTarget, page: null, canvas, srcBlob,
      quad: detected || defaultQuad(canvas.width, canvas.height),
      detected, rotation: 0, filter: filterPref,
    };
    busy(null);
    openCrop();
    if (!detected) toast('No encontré los bordes; ajusta las esquinas a mano');
  } catch (err) {
    busy(null);
    toast(err.message || 'No se pudo usar la foto');
  }
});

$('galleryInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (files.length === 1) {
    // una sola foto: mismo flujo que la cámara, con recorte manual
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    $('camInput').files = dt.files;
    $('camInput').dispatchEvent(new Event('change'));
    return;
  }
  await importMany(files, captureTarget);
});

/** Importa varias fotos de una vez: detecta, endereza y mejora cada una automáticamente. */
async function importMany(blobs, doc) {
  doc = doc || (await createDoc());
  try {
    for (let i = 0; i < blobs.length; i++) {
      busy(`Escaneando ${i + 1} de ${blobs.length}…`);
      await nextFrame();
      const { canvas, srcBlob } = await prepareSource(blobs[i]);
      const quad = autoQuad(canvas) || defaultQuad(canvas.width, canvas.height, 0);
      const out = renderPage(canvas, quad, filterPref, 0);
      await persistPage(doc, null, { srcBlob, quad, filter: filterPref, rotation: 0, outCanvas: out });
    }
  } catch (err) {
    toast(err.message || 'Algunas fotos no se pudieron procesar');
  }
  busy(null);
  openDoc(doc);
  toast(`${blobs.length} páginas agregadas. Toca una para ajustarla.`);
}

// Fotos compartidas hacia la app desde la galería u otra app
window.onSharedImages = async (urls) => {
  try {
    const blobs = await Promise.all(urls.map((u) => fetch(u).then((r) => r.blob())));
    await importMany(blobs, null);
  } catch {
    toast('No se pudieron leer las imágenes compartidas');
  }
};

async function createDoc() {
  const doc = { id: store.newId(), name: defaultName(), created: Date.now(), updated: Date.now(), pages: [] };
  await store.putDoc(doc);
  return doc;
}

async function persistPage(doc, existing, { srcBlob, quad, filter, rotation, outCanvas }) {
  const page = existing || { id: store.newId(), docId: doc.id };
  Object.assign(page, {
    src: srcBlob,
    quad: quad.map((p) => ({ x: p.x, y: p.y })),
    filter,
    rotation,
    out: await canvasToBlob(outCanvas),
    thumb: await canvasToBlob(scaled(outCanvas, 420), 'image/jpeg', 0.8),
    width: outCanvas.width,
    height: outCanvas.height,
  });
  await store.savePage(doc, page);
  return page;
}

/* =================== pantalla de recorte =================== */

const view = { scale: 1, ox: 0, oy: 0, dw: 0, dh: 0 };
let drag = null;

function openCrop() {
  show('crop');
  updateCropAllLabel();
  requestAnimationFrame(layoutCrop);
}

function layoutCrop() {
  if (!edit) return;
  const stage = $('cropStage');
  const W = stage.clientWidth, H = stage.clientHeight, pad = 26;
  const { width: sw, height: sh } = edit.canvas;
  view.scale = Math.min((W - pad * 2) / sw, (H - pad * 2) / sh);
  view.dw = sw * view.scale;
  view.dh = sh * view.scale;
  view.ox = (W - view.dw) / 2;
  view.oy = (H - view.dh) / 2;
  const c = $('cropCanvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  c.style.left = view.ox + 'px';
  c.style.top = view.oy + 'px';
  c.style.width = view.dw + 'px';
  c.style.height = view.dh + 'px';
  c.width = Math.round(view.dw * dpr);
  c.height = Math.round(view.dh * dpr);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(edit.canvas, 0, 0, c.width, c.height);
  drawOverlay();
}

const toView = (p) => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
const toSource = (x, y) => ({
  x: Math.min(edit.canvas.width, Math.max(0, (x - view.ox) / view.scale)),
  y: Math.min(edit.canvas.height, Math.max(0, (y - view.oy) / view.scale)),
});

function drawOverlay() {
  const svg = $('cropSvg');
  const W = $('cropStage').clientWidth, H = $('cropStage').clientHeight;
  const pts = edit.quad.map(toView);
  const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const mids = pts.map((p, i) => {
    const n = pts[(i + 1) % 4];
    return { x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 };
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML =
    `<path class="shade" d="M0 0H${W}V${H}H0Z M${poly.replace(/ /g, ' L')}Z"/>` +
    `<polygon class="edge" points="${poly}"/>` +
    mids.map((m) => `<circle class="mid" cx="${m.x}" cy="${m.y}" r="7"/>`).join('') +
    pts.map((p, i) => `<circle class="corner${drag && drag.kind === 'corner' && drag.index === i ? ' active' : ''}" cx="${p.x}" cy="${p.y}" r="15"/>`).join('');
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const stage = $('cropStage');
stage.addEventListener('pointerdown', (e) => {
  if (!edit) return;
  const r = stage.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const pts = edit.quad.map(toView);
  let best = null, bestD = 44;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = { kind: 'corner', index: i }; }
  });
  if (!best) {
    pts.forEach((p, i) => {
      const n = pts[(i + 1) % 4];
      const d = Math.hypot((p.x + n.x) / 2 - x, (p.y + n.y) / 2 - y);
      if (d < 34 && d < bestD) { bestD = d; best = { kind: 'edge', index: i }; }
    });
  }
  if (!best) return;
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  drag = { ...best, startX: x, startY: y, start: edit.quad.map((p) => ({ ...p })) };
  moveDrag(x, y);
});

stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = stage.getBoundingClientRect();
  moveDrag(e.clientX - r.left, e.clientY - r.top);
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  $('loupe').hidden = true;
  drawOverlay();
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

function moveDrag(x, y) {
  if (drag.kind === 'corner') {
    edit.quad[drag.index] = toSource(x, y);
    showLoupe(edit.quad[drag.index], x, y);
  } else {
    const dx = (x - drag.startX) / view.scale, dy = (y - drag.startY) / view.scale;
    const i = drag.index, j = (i + 1) % 4;
    const clampP = (p) => ({ x: Math.min(edit.canvas.width, Math.max(0, p.x)), y: Math.min(edit.canvas.height, Math.max(0, p.y)) });
    edit.quad[i] = clampP({ x: drag.start[i].x + dx, y: drag.start[i].y + dy });
    edit.quad[j] = clampP({ x: drag.start[j].x + dx, y: drag.start[j].y + dy });
  }
  drawOverlay();
}

/** Lupa: muestra ampliada la zona bajo el dedo para poner la esquina exacta. */
function showLoupe(srcPt, x, y) {
  const loupe = $('loupe');
  const ctx = loupe.getContext('2d');
  const zoom = 2.6;
  const side = 120 / (view.scale * zoom);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 240, 240);
  ctx.drawImage(edit.canvas, srcPt.x - side / 2, srcPt.y - side / 2, side, side, 0, 0, 240, 240);
  ctx.strokeStyle = '#5EE0F5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(120, 96); ctx.lineTo(120, 144);
  ctx.moveTo(96, 120); ctx.lineTo(144, 120);
  ctx.stroke();
  const W = stage.clientWidth;
  loupe.style.left = (x < W / 2 ? W - 132 : 12) + 'px';
  loupe.style.top = (y < 150 ? stage.clientHeight - 132 : 12) + 'px';
  loupe.hidden = false;
}

function updateCropAllLabel() {
  $('cropAllLabel').textContent = edit && edit.fullFrame ? (edit.detected ? 'Detectar' : 'Bordes') : 'Toda la foto';
}

$('btnCropAll').addEventListener('click', () => {
  if (!edit) return;
  if (edit.fullFrame) {
    edit.quad = edit.detected ? edit.detected.map((p) => ({ ...p })) : defaultQuad(edit.canvas.width, edit.canvas.height);
    edit.fullFrame = false;
  } else {
    edit.quad = defaultQuad(edit.canvas.width, edit.canvas.height, 0);
    edit.fullFrame = true;
  }
  updateCropAllLabel();
  drawOverlay();
});

$('btnCropRotate').addEventListener('click', () => {
  if (!edit) return;
  // girar la foto original 90° en sentido horario (y las esquinas con ella)
  const H = edit.canvas.height;
  const rot = (p) => ({ x: H - p.y, y: p.x });
  edit.canvas = rotateCanvas(edit.canvas, 1);
  edit.quad = orderClockwise(edit.quad.map(rot));
  if (edit.detected) edit.detected = orderClockwise(edit.detected.map(rot));
  edit.srcDirty = true;
  layoutCrop();
});

const orderClockwise = (pts) => {
  // después de girar, la esquina superior izquierda es otra
  let start = 0;
  pts.forEach((p, i) => { if (p.x + p.y < pts[start].x + pts[start].y) start = i; });
  return [0, 1, 2, 3].map((k) => pts[(start + k) % 4]);
};

$('btnCropNext').addEventListener('click', async () => {
  if (!edit) return;
  if (!isConvex(edit.quad)) {
    toast('Las esquinas se cruzan; acomódalas en orden');
    return;
  }
  if (edit.srcDirty) {
    edit.srcBlob = await canvasToBlob(edit.canvas, 'image/jpeg', 0.92);
    edit.srcDirty = false;
  }
  openEnhance();
});

$('btnCropCancel').addEventListener('click', cancelEdit);

function cancelEdit() {
  const doc = edit && (edit.doc || null);
  edit = null;
  if (doc) openDoc(doc);
  else goHome();
}

window.addEventListener('resize', () => {
  if (current() === 'crop') layoutCrop();
});

/* =================== pantalla de mejora =================== */

let previewUrl = null;

async function openEnhance() {
  show('enhance');
  $('enhanceBusy').hidden = false;
  await nextFrame();
  const size = outputSize(edit.quad, MAX_OUTPUT, edit.canvas.width, edit.canvas.height);
  edit.warped = warpPerspective(canvasData(edit.canvas), edit.quad, size.width, size.height);
  edit.filtered = null;
  buildChips();
  await renderEnhance();
}

function buildChips() {
  const box = $('filterChips');
  box.replaceChildren();
  const small = scaled(imageDataToCanvas(edit.warped), 200);
  for (const f of FILTERS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (f.id === edit.filter ? ' on' : '');
    chip.dataset.filter = f.id;
    const img = document.createElement('img');
    img.alt = '';
    img.src = imageDataToCanvas(applyFilter(canvasData(small), f.id)).toDataURL('image/jpeg', 0.8);
    const label = document.createElement('span');
    label.textContent = f.label;
    chip.append(img, label);
    chip.addEventListener('click', async () => {
      if (edit.filter === f.id) return;
      edit.filter = f.id;
      edit.filtered = null;
      filterPref = f.id;
      try { localStorage.setItem(FILTER_KEY, f.id); } catch { /* sin almacenamiento */ }
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      await renderEnhance();
    });
    box.appendChild(chip);
  }
}

async function renderEnhance() {
  $('enhanceBusy').hidden = false;
  await nextFrame();
  if (!edit.filtered) edit.filtered = applyFilter(edit.warped, edit.filter);
  edit.result = imageDataToCanvas(rotateImage(edit.filtered, edit.rotation));
  const blob = await canvasToBlob(edit.result, 'image/jpeg', 0.9);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  $('enhancePreview').src = previewUrl;
  $('enhanceBusy').hidden = true;
}

$('btnEnhanceRotate').addEventListener('click', async () => {
  edit.rotation = (edit.rotation + 1) % 4;
  await renderEnhance();
});

$('btnEnhanceBack').addEventListener('click', () => openCrop());

async function saveCurrentEdit() {
  busy('Guardando…');
  await nextFrame();
  const doc = edit.doc || (await createDoc());
  await persistPage(doc, edit.page, {
    srcBlob: edit.srcBlob,
    quad: edit.quad,
    filter: edit.filter,
    rotation: edit.rotation,
    outCanvas: edit.result,
  });
  busy(null);
  return doc;
}

$('btnEnhanceDone').addEventListener('click', async () => {
  try {
    const doc = await saveCurrentEdit();
    edit = null;
    openDoc(doc);
  } catch (err) {
    busy(null);
    toast('No se pudo guardar: ' + (err.message || err));
  }
});

$('btnScanMore').addEventListener('click', async () => {
  try {
    const doc = await saveCurrentEdit();
    edit = null;
    await openDoc(doc);
    startCapture(doc);
  } catch (err) {
    busy(null);
    toast('No se pudo guardar: ' + (err.message || err));
  }
});

/* =================== documento =================== */

let currentDoc = null;
let pageUrls = [];
let selectedPage = null;

async function openDoc(doc) {
  currentDoc = await store.getDoc(doc.id) || doc;
  show('doc');
  $('docName').value = currentDoc.name;
  await renderPages();
}

async function renderPages() {
  pageUrls.forEach((u) => URL.revokeObjectURL(u));
  pageUrls = [];
  const pages = await store.getPages(currentDoc);
  $('docMeta').textContent = `${pages.length} página${pages.length === 1 ? '' : 's'}`;
  const grid = $('pageGrid');
  grid.replaceChildren();
  pages.forEach((page, i) => {
    const li = document.createElement('li');
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'page-card';
    const img = document.createElement('img');
    const url = URL.createObjectURL(page.thumb || page.out);
    pageUrls.push(url);
    img.src = url;
    img.alt = `Página ${i + 1}`;
    const num = document.createElement('span');
    num.className = 'page-num';
    num.textContent = i + 1;
    card.append(img, num);
    card.addEventListener('click', () => openPageSheet(page, i, pages.length));
    li.appendChild(card);
    grid.appendChild(li);
  });
  $('btnExport').disabled = pages.length === 0;
}

$('docName').addEventListener('change', async () => {
  if (!currentDoc) return;
  currentDoc.name = $('docName').value.trim() || currentDoc.name;
  $('docName').value = currentDoc.name;
  await store.putDoc(currentDoc);
});
$('docName').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());

$('btnDocBack').addEventListener('click', goHome);
$('btnAddPage').addEventListener('click', () => startCapture(currentDoc));
$('btnAddFromGallery').addEventListener('click', () => startImport(currentDoc));

$('btnDocDelete').addEventListener('click', async () => {
  if (!currentDoc) return;
  if (!(await ask(`¿Eliminar “${currentDoc.name}” y todas sus páginas?`, 'Eliminar'))) return;
  await store.deleteDoc(currentDoc);
  currentDoc = null;
  goHome();
  toast('Documento eliminado');
});

function openPageSheet(page, index, total) {
  selectedPage = { page, index, total };
  $('pageSheetTitle').textContent = `Página ${index + 1} de ${total}`;
  $('pageSheet').querySelector('[data-act="left"]').disabled = index === 0;
  $('pageSheet').querySelector('[data-act="right"]').disabled = index === total - 1;
  $('pageSheet').hidden = false;
}
const closeSheets = () => {
  $('pageSheet').hidden = true;
  $('exportSheet').hidden = true;
};
['pageSheet', 'exportSheet'].forEach((id) =>
  $(id).addEventListener('click', (e) => {
    if (e.target === $(id)) closeSheets();
  }),
);

$('pageSheet').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !selectedPage) return;
  const { page, index } = selectedPage;
  closeSheets();
  const doc = currentDoc;
  switch (btn.dataset.act) {
    case 'edit': {
      busy('Abriendo…');
      const canvas = await blobToCanvas(page.src);
      edit = {
        doc, page, canvas, srcBlob: page.src,
        quad: page.quad.map((p) => ({ ...p })),
        detected: null, rotation: page.rotation || 0, filter: page.filter || filterPref,
      };
      busy(null);
      openCrop();
      break;
    }
    case 'rotate': {
      busy('Girando…');
      const outCanvas = rotateCanvas(await blobToCanvas(page.out), 1);
      await persistPage(doc, page, { srcBlob: page.src, quad: page.quad, filter: page.filter, rotation: ((page.rotation || 0) + 1) % 4, outCanvas });
      busy(null);
      await renderPages();
      break;
    }
    case 'left':
    case 'right': {
      const j = btn.dataset.act === 'left' ? index - 1 : index + 1;
      [doc.pages[index], doc.pages[j]] = [doc.pages[j], doc.pages[index]];
      await store.putDoc(doc);
      await renderPages();
      break;
    }
    case 'delete':
      if (await ask('¿Eliminar esta página?', 'Eliminar')) {
        await store.deletePage(doc, page.id);
        await renderPages();
      }
      break;
    default:
  }
});

/* =================== exportar =================== */

$('btnExport').addEventListener('click', () => {
  const n = currentDoc.pages.length;
  $('exportInfo').textContent = `${currentDoc.name} · ${n} página${n === 1 ? '' : 's'}`;
  $('exportSheet').hidden = false;
});

const A4 = { w: 595.28, h: 841.89 };

async function buildPdf(pages) {
  const { PDFDocument } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(currentDoc.name);
  pdf.setCreator('Escáner DECOM');
  for (const page of pages) {
    const img = await pdf.embedJpg(new Uint8Array(await page.out.arrayBuffer()));
    const aspect = img.width / img.height;
    let w, h;
    if (aspect <= 1) {
      w = A4.w;
      h = w / aspect;
      if (Math.abs(h / A4.h - 1) < 0.05) h = A4.h;
    } else {
      w = A4.h;
      h = w / aspect;
      if (Math.abs(h / A4.w - 1) < 0.05) h = A4.w;
    }
    pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

const toBase64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Envía un archivo a Android. destino: "dispositivo" o "compartir". Devuelve el uri. */
function sendToNative(bytes, name, mime, destino) {
  native.beginFile(name);
  const CHUNK = 384 * 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) native.appendFile(toBase64(bytes.subarray(i, i + CHUNK)));
  return native.endFile(mime, destino);
}

function download(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('exportSheet').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-exp]');
  if (!btn) return;
  closeSheets();
  const kind = btn.dataset.exp;
  const pages = await store.getPages(currentDoc);
  if (!pages.length) return;
  const base = safeName(currentDoc.name);
  try {
    if (kind === 'pdf' || kind === 'share-pdf') {
      busy('Creando PDF…');
      await nextFrame();
      const bytes = await buildPdf(pages);
      busy(null);
      if (!native) return download(bytes, `${base}.pdf`, 'application/pdf');
      if (kind === 'share-pdf') {
        if (sendToNative(bytes, `${base}.pdf`, 'application/pdf', 'compartir')) native.shareQueued('application/pdf');
        else toast('No se pudo preparar el PDF');
        return;
      }
      const uri = sendToNative(bytes, `${base}.pdf`, 'application/pdf', 'dispositivo');
      if (!uri) return toast('No se pudo guardar el PDF');
      if (await ask('PDF guardado en Descargas › Escaner DECOM', 'Abrir', 'Listo')) native.openUri(uri, 'application/pdf');
      return;
    }
    // imágenes
    const share = kind === 'share-jpg';
    let ok = 0;
    for (let i = 0; i < pages.length; i++) {
      busy(`${share ? 'Preparando' : 'Guardando'} imagen ${i + 1} de ${pages.length}…`);
      await nextFrame();
      const bytes = new Uint8Array(await pages[i].out.arrayBuffer());
      const name = pages.length > 1 ? `${base}_${i + 1}.jpg` : `${base}.jpg`;
      if (!native) download(bytes, name, 'image/jpeg');
      else if (sendToNative(bytes, name, 'image/jpeg', share ? 'compartir' : 'dispositivo')) ok++;
    }
    busy(null);
    if (!native) return;
    if (share) native.shareQueued('image/jpeg');
    else toast(ok === pages.length ? `${ok} imagen${ok === 1 ? '' : 'es'} guardada${ok === 1 ? '' : 's'} en la Galería` : 'Algunas imágenes no se pudieron guardar');
  } catch (err) {
    busy(null);
    console.error(err);
    toast('No se pudo exportar: ' + (err.message || err));
  }
});

/* =================== inicio =================== */

let homeUrls = [];

async function goHome() {
  currentDoc = null;
  show('home');
  homeUrls.forEach((u) => URL.revokeObjectURL(u));
  homeUrls = [];
  let docs = [];
  try {
    docs = await store.listDocs();
  } catch {
    toast('No se pudieron leer los documentos guardados');
  }
  const list = $('docList');
  list.replaceChildren();
  $('docEmpty').hidden = docs.length > 0;
  for (const doc of docs) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'doc-item';
    const img = document.createElement('img');
    img.className = 'doc-thumb';
    img.alt = '';
    const first = doc.pages[0] ? await store.getPage(doc.pages[0]) : null;
    if (first) {
      const url = URL.createObjectURL(first.thumb || first.out);
      homeUrls.push(url);
      img.src = url;
    }
    const text = document.createElement('span');
    text.className = 'doc-text';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = doc.name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${doc.pages.length} pág. · ${formatDate(doc.updated)}`;
    text.append(name, meta);
    btn.append(img, text);
    btn.addEventListener('click', () => openDoc(doc));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

$('btnScan').addEventListener('click', () => startCapture(null));
$('btnImport').addEventListener('click', () => startImport(null));

/* =================== botón atrás de Android =================== */

window.handleBack = () => {
  if (!$('dialog').hidden) {
    closeDialog(false);
    return true;
  }
  if (!$('pageSheet').hidden || !$('exportSheet').hidden) {
    closeSheets();
    return true;
  }
  if (!$('busyOverlay').hidden) return true;
  switch (current()) {
    case 'enhance':
      openCrop();
      return true;
    case 'crop':
      cancelEdit();
      return true;
    case 'doc':
      goHome();
      return true;
    default:
      return false;
  }
};

/* =================== arranque =================== */

goHome();
setTimeout(() => {
  const splash = $('splash');
  splash.classList.add('gone');
  setTimeout(() => splash.remove(), 500);
}, 1200);
