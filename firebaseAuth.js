import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import admin from 'firebase-admin';

/**
 * Custom Baileys Auth State that saves to Firebase Firestore.
 * This is crucial for Render because Render's ephemeral filesystem
 * resets on every deploy or sleep.
 */
export const useFirebaseAuthState = async (collectionName) => {
    const db = admin.firestore();
    const collection = db.collection(collectionName);

    const writeData = async (data, id) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            const parsed = JSON.parse(stringified);
            await collection.doc(id).set(parsed);
        } catch (error) {
            console.error(`Firebase write error for ${id}:`, error);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await collection.doc(id).get();
            if (doc.exists) {
                const data = doc.data();
                return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`Firebase read error for ${id}:`, error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.doc(id).delete();
        } catch (error) {
            console.error(`Firebase remove error for ${id}:`, error);
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
