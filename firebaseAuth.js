import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import admin from 'firebase-admin';

/**
 * Custom Baileys Auth State that saves to Firebase Firestore.
 * This is crucial for Render because Render's ephemeral filesystem
 * resets on every deploy or sleep.
 */
export const useFirebaseAuthState = async (collectionName) => {
    console.log(`[Firebase Auth] Starting setup for collection: "${collectionName}"`);
    
    let db;
    try {
        db = admin.firestore();
        console.log(`[Firebase Auth] Firestore reference retrieved successfully.`);
    } catch (e) {
        console.error(`[Firebase Auth] Failed to get Firestore reference:`, e.message);
        throw e;
    }

    const collection = db.collection(collectionName);

    const writeData = async (data, id) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            const parsed = JSON.parse(stringified);
            await collection.doc(id).set(parsed);
        } catch (error) {
            console.error(`[Firebase Auth] Write error for "${id}":`, error.message);
        }
    };

    const readData = async (id) => {
        try {
            console.log(`[Firebase Auth] Reading key: "${id}"...`);
            // Set safety timeout for Firebase operation
            const fetchPromise = collection.doc(id).get();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Firebase read timeout (15s). Check credential permissions / network.')), 15000)
            );
            
            const doc = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (doc.exists) {
                console.log(`[Firebase Auth] Key "${id}" found in Firestore.`);
                const data = doc.data();
                return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
            }
            console.log(`[Firebase Auth] Key "${id}" does not exist in Firestore yet.`);
            return null;
        } catch (error) {
            console.error(`[Firebase Auth] Read error for "${id}":`, error.message);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.doc(id).delete();
            console.log(`[Firebase Auth] Deleted key: "${id}"`);
        } catch (error) {
            console.error(`[Firebase Auth] Remove error for "${id}":`, error.message);
        }
    };

    console.log(`[Firebase Auth] Fetching initial "creds" key...`);
    const creds = await readData('creds') || initAuthCreds();
    console.log(`[Firebase Auth] Initial creds configuration loaded.`);

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
