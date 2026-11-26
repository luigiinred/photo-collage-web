const NAME = 'collage-maker';
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('photos', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(tx)).then((r) => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const isAvailable = () => open().then(() => true, () => false);
export const putProject = (p) => run('projects', 'readwrite', (tx) => wrap(tx.objectStore('projects').put(p)));
export const getProject = (id) => run('projects', 'readonly', (tx) => wrap(tx.objectStore('projects').get(id)));
export const listProjects = () =>
  run('projects', 'readonly', (tx) => wrap(tx.objectStore('projects').getAll())).then((l) => l.sort((a, b) => b.updated - a.updated));
export const putPhoto = (p) => run('photos', 'readwrite', (tx) => wrap(tx.objectStore('photos').put(p)));
export const deletePhoto = (id) => run('photos', 'readwrite', (tx) => wrap(tx.objectStore('photos').delete(id)));
export const getPhotos = (projectId) =>
  run('photos', 'readonly', (tx) => wrap(tx.objectStore('photos').index('projectId').getAll(projectId)));

export async function deleteProject(id) {
  const photos = await getPhotos(id);
  await run(['projects', 'photos'], 'readwrite', async (tx) => {
    tx.objectStore('projects').delete(id);
    for (const p of photos) tx.objectStore('photos').delete(p.id);
  });
}
