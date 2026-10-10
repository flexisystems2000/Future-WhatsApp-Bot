import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  downloadMediaMessage
} from "@musteqeem/baileys";
import { GoogleGenAI } from "@google/genai";
import express from "express";
import pino from "pino";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Global runtime variables
let sock = null;
let isConnected = false;

// Bot Memory State
const state = {
  isAway: true,
  mutedChats: new Set()
};

// --- Web Dashboard UI (Mobile & Desktop Responsive) ---
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Bot Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-xl font-bold tracking-wide text-emerald-400">🤖 WhatsApp Bot</h1>
          <span id="status-badge" class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            Checking...
          </span>
        </div>

        <div id="setup-section" class="space-y-4">
          <p class="text-sm text-slate-400">Enter your WhatsApp phone number with country code (e.g. <span class="text-slate-200">2348123456789</span>) to generate your pairing code.</p>
          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">Phone Number</label>
            <input type="text" id="phone-input" placeholder="2348123456789" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          </div>
          <button onclick="requestPairingCode()" id="pair-btn" class="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl transition duration-200 text-sm shadow-lg shadow-emerald-900/30 cursor-pointer">
            Get Pairing Code
          </button>
        </div>

        <div id="code-container" class="hidden mt-6 bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
          <p class="text-xs text-slate-400 mb-2">Your 8-Digit Pairing Code:</p>
          <div id="pairing-code-display" class="text-3xl font-mono font-bold tracking-widest text-emerald-400 select-all">
            ---- - ----
          </div>
          <p class="text-xs text-slate-500 mt-2">Go to WhatsApp &gt; Linked Devices &gt; Link with phone number instead</p>
        </div>

        <div id="connected-banner" class="hidden mt-6 bg-emerald-950/40 border border-emerald-800/50 rounded-xl p-4 text-center">
          <p class="text-emerald-400 font-semibold text-sm">✅ Bot is active and connected!</p>
        </div>
      </div>

      <script>
        async function fetchStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const badge = document.getElementById('status-badge');
            const setupSec = document.getElementById('setup-section');
            const connectedBanner = document.getElementById('connected-banner');

            if (data.connected) {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
              badge.innerText = "Connected";
              setupSec.classList.add('hidden');
              connectedBanner.classList.remove('hidden');
            } else {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20";
              badge.innerText = "Waiting for Pairing";
            }
          } catch (e) {}
        }

        async function requestPairingCode() {
          const phone = document.getElementById('phone-input').value.trim();
          const btn = document.getElementById('pair-btn');
          if (!phone) {
            alert("Please enter a valid phone number.");
            return;
          }

          btn.innerText = "Generating...";
          btn.disabled = true;

          try {
            const res = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();

            if (data.success && data.code) {
              document.getElementById('pairing-code-display').innerText = data.code;
              document.getElementById('code-container').classList.remove('hidden');
            } else {
              alert(data.error || "Failed to generate pairing code.");
            }
          } catch (e) {
            alert("Network error occurred.");
          } finally {
            btn.innerText = "Get Pairing Code";
            btn.disabled = false;
          }
        }

        setInterval(fetchStatus, 4000);
        fetchStatus();
      </script>
    </body>
    </html>
  `);
});

app.get("/api/status", (req, res) => {
  res.json({ connected: isConnected });
});

app.post("/api/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required." });
  }

  if (isConnected) {
    return res.json({ success: false, error: "Bot is already connected." });
  }

  try {
    const cleanNumber = phone.replace(/[^0-9]/g, "");
    if (!sock) {
      return res.status(500).json({ success: false, error: "Bot socket not ready yet. Please wait a few seconds and try again." });
    }
    const code = await sock.requestPairingCode(cleanNumber);
    res.json({ success: true, code });
  } catch (err) {
    console.error("Pairing code error:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to get pairing code." });
  }
});

// --- Baileys Bot Logic ---
async function startBot() {
  const { state: authState, saveCreds } = await useMultiFileAuthState("./auth_session");

  sock = makeWASocket({
    auth: authState,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      }
    } else if (connection === "open") {
      isConnected = true;
      console.log("✅ Personal WhatsApp Bot Active & Connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message) continue;

      const jid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;

      // 4. Read Receipts
      if (!isFromMe) {
        await sock.readMessages([msg.key]);
      }

      // 1. Open View Once Messages
      await handleViewOnce(sock, msg);

      // Extract raw text content
      const text = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        msg.message.imageMessage?.caption || 
        "";

      if (!text) continue;

      // Handle Owner Admin Commands
      if (isFromMe) {
        if (await handleAdminCommands(sock, msg, text, jid)) continue;
      }

      // Ignore auto-responses if sent by yourself or if chat is muted
      if (isFromMe || state.mutedChats.has(jid)) continue;

      // 3. Respond only when Away mode is ON
      if (state.isAway) {
        await handleAIResponse(sock, msg, text, jid);
      }
    }
  });
}

/**
 * Feature 1: Handles incoming View Once Media and sends back a permanent copy
 */
async function handleViewOnce(sock, msg) {
  const voMsg = msg.message.viewOnceMessage?.message || 
                msg.message.viewOnceMessageV2?.message || 
                msg.message.viewOnceMessageV2Extension?.message;

  if (!voMsg) return;

  try {
    const mediaType = Object.keys(voMsg)[0];
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    
    let mediaPayload = {};
    if (mediaType === "imageMessage") mediaPayload = { image: buffer, caption: "🔓 Anti-View Once Image" };
    else if (mediaType === "videoMessage") mediaPayload = { video: buffer, caption: "🔓 Anti-View Once Video" };
    else if (mediaType === "audioMessage") mediaPayload = { audio: buffer, ptt: true };

    await sock.sendMessage(msg.key.remoteJid, mediaPayload, { quoted: msg });
  } catch (err) {
    console.error("Failed to extract View Once media:", err);
  }
}

/**
 * Features 2 & 3: Commands Handler (.menu, .block, .unblock, .away, .mute, .unmute)
 */
async function handleAdminCommands(sock, msg, text, jid) {
  const command = text.trim().toLowerCase();

  // Menu Command
  if (command === ".menu" || command === ".help") {
    const awayStatus = state.isAway ? "🟢 ON" : "🔴 OFF";
    const isMuted = state.mutedChats.has(jid) ? "🔇 MUTED" : "🔊 UNMUTED";

    const menuText = `🤖 *PERSONAL BOT DASHBOARD*

⚙️ *Bot Status:*
- Away Mode: ${awayStatus}
- Chat Status: ${isMuted}

🛠️ *Admin Commands:*
▫️ \`.away on\` - Enable away auto-responder
▫️ \`.away off\` - Disable away auto-responder
▫️ \`.mute\` - Mute bot in this chat
▫️ \`.unmute\` - Unmute bot in this chat
▫️ \`.block\` - Block contact (or reply target)
▫️ \`.unblock\` - Unblock contact (or reply target)
▫️ \`.menu\` - Display this dashboard

🌟 *Automatic Features:*
▫️ *Anti-View Once:* Reveals View Once photos/videos/audios.
▫️ *Read Receipts:* Sends blue ticks when processing.
▫️ *AI Assistant:* Natural answers & local time awareness.
▫️ *Auto Translation:* Translates non-English incoming text.`;

    await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
    return true;
  }

  // Feature 2: Block / Unblock User
  if (command.startsWith(".block")) {
    const targetJid = msg.message.extendedTextMessage?.contextInfo?.participant || jid;
    await sock.updateBlockStatus(targetJid, "block");
    await sock.sendMessage(jid, { text: "🚫 User blocked." }, { quoted: msg });
    return true;
  }
  
  if (command.startsWith(".unblock")) {
    const targetJid = msg.message.extendedTextMessage?.contextInfo?.participant || jid;
    await sock.updateBlockStatus(targetJid, "unblock");
    await sock.sendMessage(jid, { text: "✅ User unblocked." }, { quoted: msg });
    return true;
  }

  // Feature 3: Away Mode Control
  if (command === ".away on") {
    state.isAway = true;
    await sock.sendMessage(jid, { text: "🌙 Away mode activated. Bot will auto-reply." }, { quoted: msg });
    return true;
  }
  if (command === ".away off") {
    state.isAway = false;
    await sock.sendMessage(jid, { text: "☀️ Away mode deactivated. Bot will stay quiet." }, { quoted: msg });
    return true;
  }

  // Feature 3: Mute / Unmute Per Chat
  if (command === ".mute") {
    state.mutedChats.add(jid);
    await sock.sendMessage(jid, { text: "🔇 Bot muted for this chat." }, { quoted: msg });
    return true;
  }
  if (command === ".unmute") {
    state.mutedChats.delete(jid);
    await sock.sendMessage(jid, { text: "🔊 Bot unmuted for this chat." }, { quoted: msg });
    return true;
  }

  return false;
}

/**
 * Features 5, 6, 7 & 8: AI Engine with Natural Language, Time Teller, and Translation
 */
async function handleAIResponse(sock, msg, text, jid) {
  const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const currentDate = new Date().toLocaleDateString();

  const systemInstruction = `
    You are a personal WhatsApp AI assistant replying on behalf of your owner who is currently away.
    - Context: Current Date is ${currentDate}, Current Time is ${currentTime}.
    - Goal 1: Respond naturally, concisely, and helpfully to questions.
    - Goal 2: If asked about time or date, answer using the current context provided above.
    - Goal 3: Language Detection: If the user message is written in ANY language other than English, provide a brief English translation at the beginning of your response formatted like:
      "[Translation: <English translation>]" followed by your response in the user's native language (or in English).
    - Keep responses short and suitable for chat messages.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: text,
      config: {
        systemInstruction: systemInstruction,
      }
    });

    if (response.text) {
      await sock.sendMessage(jid, { text: response.text }, { quoted: msg });
    }
  } catch (err) {
    console.error("Gemini AI error:", err);
  }
}

// Start Express Server & Bot Socket
app.listen(PORT, () => {
  console.log(`🚀 Web Dashboard running on port ${PORT}`);
  startBot();
});
