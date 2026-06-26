import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import qrcode from 'qrcode-terminal';
import { useFirebaseAuthState } from './firebaseAuth.js';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;
const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8789/v1/chat/completions';
const HERMES_API_KEY = process.env.HERMES_API_KEY || 'hermes-local-key';
const BOT_SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT || 'Kamu adalah asisten pintar dan ramah.';
const FIREBASE_COLLECTION = process.env.FIREBASE_COLLECTION || 'baileys_session';

// Validate Firebase Config
if (!FIREBASE_CONFIG) {
    console.error("FATAL ERROR: FIREBASE_CONFIG environment variable is not set.");
    console.error("Please set it with the JSON content of your Firebase Service Account.");
    process.exit(1);
}

// Initialize Firebase
try {
    const serviceAccount = JSON.parse(FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase initialized successfully.");
} catch (error) {
    console.error("Failed to parse FIREBASE_CONFIG or initialize Firebase:", error.message);
    process.exit(1);
}

const logger = pino({ level: 'silent' });

async function queryHermes(messageText, senderId) {
    try {
        const response = await axios.post(HERMES_URL, {
            model: "hermes",
            messages: [
                { role: "system", content: BOT_SYSTEM_PROMPT },
                { role: "user", content: messageText }
            ],
            user: senderId, // Useful for Hermes to maintain context if it tracks user IDs
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${HERMES_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 seconds timeout
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error communicating with Hermes:", error.message);
        return "Maaf, sistem sedang mengalami gangguan saat memproses pesan Anda.";
    }
}

async function connectToWhatsApp() {
    console.log("Initializing Firebase Auth State...");
    const { state, saveCreds } = await useFirebaseAuthState(FIREBASE_COLLECTION);

    const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: true,
        browser: ['Hermes WA Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Scan QR Code ini untuk login:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('You are logged out. Please clear the Firebase collection to scan QR again.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid;
        const isGroup = senderId.endsWith('@g.us');
        
        // Optional: Ignore groups by default
        if (isGroup && process.env.IGNORE_GROUPS === 'true') return;

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!messageContent) return; // Ignore non-text messages for now

        console.log(`Received message from ${senderId}: ${messageContent}`);

        // Show typing indicator
        await sock.sendPresenceUpdate('composing', senderId);

        // Query Hermes API
        const hermesReply = await queryHermes(messageContent, senderId);

        // Send reply
        await sock.sendMessage(senderId, { text: hermesReply }, { quoted: msg });
    });
}

connectToWhatsApp();

// --- EXPRESS SERVER ---
// Required for Render so it binds to a port and doesn't kill the process
const app = express();

app.get('/', (req, res) => {
    res.send('WhatsApp Hermes Bot is running.');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});
