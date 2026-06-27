import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import { useFirebaseAuthState } from './firebaseAuth.js';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;
const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8789/v1/chat/completions';
const HERMES_API_KEY = process.env.HERMES_API_KEY || 'hermes-local-key';
const BOT_SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT || 'Kamu adalah asisten pintar dan ramah.';
const FIREBASE_COLLECTION = process.env.FIREBASE_COLLECTION || 'baileys_session';

let latestQr = null;
let isConnected = false;

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
            user: senderId,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${HERMES_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 120000 // Diperpanjang menjadi 120 detik (2 menit) agar Hermes punya cukup waktu berfikir dan eksekusi 
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
        browser: ['Hermes WA Bot', 'Chrome', '1.0.0']
    });
    
    sockInstance = sock; // Simpan ke variabel global untuk Express

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code generated. Buka URL Web Service Anda di endpoint /qr untuk scan.');
            latestQr = qr;
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('You are logged out. Please clear the Firebase collection to scan QR again.');
                latestQr = null; // Terjadi logout, hapus QR
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened!');
            isConnected = true;
            latestQr = null; // Hapus QR dari memori setelah berhasil terhubung
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid;
        const isGroup = senderId.endsWith('@g.us');
        
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!messageContent) return;

        console.log(`Received message from ${senderId}: ${messageContent}`);

        // Konfigurasi Admin
        const ADMIN_ID = '178206950817860';
        
        if (isGroup) {
            return; // Tuli di grup
        } else {
            if (!senderId.startsWith(ADMIN_ID)) {
                console.log(`Mengabaikan DM dari non-admin: ${senderId}`);
                return;
            }
        }

        // --- SISTEM AUTO CLEAR CHAT / RESET SESSION ---
        // Karena Render menyimpan variabel di memory (RAM), kita bisa mencatat jumlah chat di memori.
        // Jika Render restart, memori ini mulai dari 0 lagi (yang mana bagus untuk performa Hermes).
        if (!global.chatCounter) global.chatCounter = {};
        
        const MAX_CHAT_HISTORY = 10; // Nila ideal untuk bot WA agar tetap ringan

        // Jika user mengetik manual "/clear" atau "/reset"
        if (messageContent.toLowerCase() === '/clear' || messageContent.toLowerCase() === '/reset') {
            global.chatCounter[senderId] = 0;
            // Ubah senderId sedikit agar Hermes menganggap ini sesi baru
            await sock.sendMessage(senderId, { text: '🔄 Sesi obrolan dan ingatan jangka pendek telah direset. Silakan mulai topik baru.' });
            return;
        }

        if (!global.chatCounter[senderId]) {
            global.chatCounter[senderId] = 1;
        } else {
            global.chatCounter[senderId]++;
        }

        // Modifikasi senderId yang dikirim ke Hermes untuk membuat sesi baru di backend
        // Kita menggunakan pembagian (Math.floor) agar ID ganti setiap MAX_CHAT_HISTORY tercapai.
        const sessionCycle = Math.floor(global.chatCounter[senderId] / MAX_CHAT_HISTORY);
        const virtualSessionId = `${senderId}_cycle_${sessionCycle}`;

        await sock.sendPresenceUpdate('composing', senderId);
        // Kirim virtualSessionId ke Hermes, bukan senderId asli.
        const hermesReply = await queryHermes(messageContent, virtualSessionId);
        
        // Cek jika saat ini tepat pada batas reset (untuk memberitahu user)
        if (global.chatCounter[senderId] % MAX_CHAT_HISTORY === 0) {
            await sock.sendMessage(senderId, { text: hermesReply + "\n\n*(Memori sesi ini telah mencapai batas dan direset untuk menjaga kecepatan respon)*" }, { quoted: msg });
        } else {
            await sock.sendMessage(senderId, { text: hermesReply }, { quoted: msg });
        }
    });
}

connectToWhatsApp();

// --- EXPRESS SERVER ---
const app = express();
app.use(express.json()); // Tambahkan middleware untuk parsing JSON body

app.get('/', (req, res) => {
    res.send('WhatsApp Hermes Bot is running.');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Endpoint proaktif untuk mengirim pesan (digunakan oleh Cronjob Hermes)
let sockInstance = null; // Menyimpan instance sock agar bisa diakses express

app.post('/api/sendText', async (req, res) => {
    try {
        if (!sockInstance || !isConnected) {
            return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
        }
        
        const { chatId, text, apiKey } = req.body;
        
        // Simple Auth (Gunakan API_KEY yang sama dengan HERMES_API_KEY atau API_KEY khusus di Render)
        const expectedApiKey = process.env.API_KEY || 'hermes-cron-key';
        if (apiKey !== expectedApiKey) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        if (!chatId || !text) {
            return res.status(400).json({ success: false, error: 'chatId and text are required' });
        }

        await sockInstance.sendMessage(chatId, { text: text });
        res.status(200).json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error("Error in /api/sendText:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk merender halaman QR Code dengan rapi (agar bisa discan)
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="color: green; text-align: center; font-family: Arial;">WhatsApp sudah berhasil terhubung! 🎉</h2>');
    }
    if (!latestQr) {
        return res.send('<h2 style="text-align: center; font-family: Arial;">QR Code belum siap atau sedang dimuat ulang.<br>Silakan refresh halaman ini (F5) dalam beberapa detik lagi.</h2>');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Scan QR Code WhatsApp Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
            <style>
                body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; margin: 0; text-align: center;}
                #qrcode { margin: 20px auto; padding: 20px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; }
                h2 { color: #128c7e; margin-bottom: 5px;}
                p { color: #555; }
            </style>
        </head>
        <body>
            <h2>Hubungkan Bot WhatsApp</h2>
            <p>Buka WhatsApp di HP Anda ➔ Perangkat Taut ➔ Tautkan Perangkat</p>
            <div id="qrcode"></div>
            <p><small>Halaman ini akan refresh otomatis setiap 15 detik</small></p>
            
            <script>
                new QRCode(document.getElementById("qrcode"), {
                    text: "${latestQr}",
                    width: 256,
                    height: 256,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.M
                });
                
                // Auto refresh
                setTimeout(() => { location.reload(); }, 15000);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});
