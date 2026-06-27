import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import admin from 'firebase-admin';

export const useFirebaseAuthState = async (collectionName) => {
    const db = admin.firestore();
    const collection = db.collection(collectionName);

    const writeData = async (data, id) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            const parsed = JSON.parse(stringified);
            
            // Perbaikan: Pastikan data berupa plain object (Firestore requirement)
            let docData = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) 
                ? parsed 
                : { _wrapped: true, value: parsed };

            await collection.doc(id).set(docData);
        } catch (error) {
            console.error(`[Firebase Auth] Write error for "${id}":`, error.message);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await collection.doc(id).get();
            if (doc.exists) {
                const data = doc.data();
                let parsed = JSON.parse(JSON.stringify(data), BufferJSON.reviver);
                
                // Jika data dibungkus, buka kembali
                if (parsed && typeof parsed === 'object' && parsed._wrapped) {
                    parsed = parsed.value;
                }
                return parsed;
            }
            return null;
        } catch (error) {
            console.error(`[Firebase Auth] Read error for "${id}":`, error.message);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.doc(id).delete();
        } catch (error) {
            console.error(`[Firebase Auth] Remove error for "${id}":`, error.message);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = import('@whiskeysockets/baileys').then(m => m.proto.Message.AppStateSyncKeyData.fromObject(value));
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const docId = `${category}-${id}`;
                            tasks.push(value ? writeData(value, docId) : removeData(docId));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};
