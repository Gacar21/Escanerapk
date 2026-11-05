// Guarda documentos y páginas escaneadas en el teléfono (IndexedDB, dentro de la app).
//
// Documento: { id, name, created, updated, pages: [pageId, ...] }
// Página:    { id, docId, src: Blob, quad: [{x,y}×4], filter, rotation, out: Blob, thumb: Blob, width, height }

const DB_NAME = 'escaner-decom';
const DB_VERSION = 1;
let dbPromise = null;

const open = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
};

const tx = async (stores, mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Sin espacio en el teléfono'));
  });
};

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const listDocs = () =>
  tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').getAll())).then((docs) => docs.sort((a, b) => b.updated - a.updated));

export const getDoc = (id) => tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').get(id)));

export const putDoc = (doc) => tx(['docs'], 'readwrite', (t) => {
  doc.updated = Date.now();
  t.objectStore('docs').put(doc);
});

export const getPage = (id) => tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').get(id)));

export const getPages = async (doc) => {
  const pages = await tx(['pages'], 'readonly', (t) => Promise.all(doc.pages.map((id) => req(t.objectStore('pages').get(id)))));
  return pages.filter(Boolean);
};

/** Guarda una página y la agrega al documento si es nueva. */
export const savePage = (doc, page) => tx(['docs', 'pages'], 'readwrite', (t) => {
  t.objectStore('pages').put(page);
  if (!doc.pages.includes(page.id)) doc.pages.push(page.id);
  doc.updated = Date.now();
  t.objectStore('docs').put(doc);
});

export const deletePage = (doc, pageId) => tx(['docs', 'pages'], 'readwrite', (t) => {
  t.objectStore('pages').delete(pageId);
  doc.pages = doc.pages.filter((id) => id !== pageId);
  doc.updated = Date.now();
  t.objectStore('docs').put(doc);
});

export const deleteDoc = (doc) => tx(['docs', 'pages'], 'readwrite', (t) => {
  for (const id of doc.pages) t.objectStore('pages').delete(id);
  t.objectStore('docs').delete(doc.id);
});
