import { DB_NAME, DB_VERSION, STORE, MAX_SESSIONS } from './constants.js';

const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

export class SessionStore {
    async put(session) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.put(session);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async delete(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async list() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const req = store.getAll();
            req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
            req.onerror = () => reject(req.error);
        });
    }

    async prune(max = MAX_SESSIONS) {
        const sessions = await this.list();
        if (sessions.length <= max) return;
        const toDrop = sessions.slice(max);
        await Promise.all(toDrop.map(({ id }) => this.delete(id)));
    }
}
