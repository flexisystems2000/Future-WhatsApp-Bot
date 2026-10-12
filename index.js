import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  downloadContentFromMessage
} from "@musteqeem/baileys";
import OpenAI from "openai";
import { init as initPuter } from "@heyputer/puter.js/src/init.cjs";
import express from "express";
import fs from "fs";
import path from "path";
import pino from "pino";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const KNOWLEDGE_FILE = "./knowledge.json";
const MEDIA_DIR = "./media";
const MEDIA_FILE = "./media_knowledge.json";

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Helper functions for Text Knowledge Base
function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("Error loading knowledge file:", e.message);
  }
  return [];
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error saving knowledge file:", e);
  }
}

// Helper functions for Media Vault
function loadMediaKnowledge() {
  try {
    if (fs.existsSync(MEDIA_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEDIA_FILE, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("Error loading media knowledge file:", e.message);
  }
  return [];
}

function saveMediaKnowledge(data) {
  try {
    fs.writeFileSync(MEDIA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error saving media knowledge file:", e);
  }
}

// Normalize WhatsApp JIDs for reliable identity comparison.
function normalizeWhatsAppId(value = "") {
  return String(value)
    .split("@")[0]
    .split(":")[0]
    .replace(/[^0-9]/g, "");
}

// Get the bot's connected WhatsApp identities.
function getConnectedBotNumbers(sock) {
  const identities = [
    sock?.user?.id,
    sock?.user?.lid
  ];

  return identities
    .filter(Boolean)
    .map(normalizeWhatsAppId)
    .filter(Boolean);
}

// Detect mentions using WhatsApp metadata and @future keyword.
function isBotMentioned(sock, msg, text = "") {
  const message = msg.message || {};

  const contextInfo =
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.buttonsResponseMessage?.contextInfo ||
    message.listResponseMessage?.contextInfo ||
    {};

  const mentions = contextInfo.mentionedJid || [];
  const botNumbers = getConnectedBotNumbers(sock);

  const mentionMatchesBot = mentions.some(mentionedJid => {
    const mentionedNumber = normalizeWhatsAppId(mentionedJid);
    return botNumbers.includes(mentionedNumber);
  });

  const mentionsFuture = /@future\b/i.test(text);

  return mentionMatchesBot || mentionsFuture;
}

// 1. Multi-API Key setup for OpenRouter rotation
const apiKeys = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

// 2. Initialize Puter for Image Generation
const puter = initPuter(process.env.PUTER_AUTH_TOKEN);

// Global runtime variables
let sock = null;
let isConnected = false;

// Bot Memory State
const state = {
  isAway: true,
  mutedChats: new Set(),
  checkedChats: new Set(),
  activeConversations: new Map() // Stores JID -> Timestamp for auto-sleep
};

const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes timeout for group auto-sleep

// --- Web Dashboard UI ---
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Multi-AI Bot Dashboard</title>
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

// --- OpenRouter Vision & Text Handlers with Key Rotation ---
async function callOpenRouterVision(systemPrompt, base64Image, userText) {
  if (apiKeys.length === 0) {
    throw new Error("No OpenRouter API keys found in OPENROUTER_API_KEYS environment variable!");
  }

  let lastError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[currentKeyIndex];
    try {
      const openrouter = new OpenAI({
        apiKey: apiKey,
        baseURL: "https://openrouter.ai/api/v1"
      });

      const messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }
      ];

      const completion = await openrouter.chat.completions.create({
        model: "google/gemini-2.5-flash",
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      });

      return completion.choices[0]?.message?.content || "No response generated.";
    } catch (err) {
      console.warn(`⚠️ OpenRouter Vision API Key index ${currentKeyIndex} failed: ${err.message}. Rotating key...`);
      lastError = err;
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    }
  }
  throw lastError || new Error("All OpenRouter API keys failed for vision.");
}

async function callOpenRouterGemini(systemPrompt, userText) {
  if (apiKeys.length === 0) {
    throw new Error("No OpenRouter API keys found in OPENROUTER_API_KEYS environment variable!");
  }

  let lastError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[currentKeyIndex];
    try {
      const openrouter = new OpenAI({
        apiKey: apiKey,
        baseURL: "https://openrouter.ai/api/v1"
      });

      const completion = await openrouter.chat.completions.create({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        temperature: 0.7,
        max_tokens: 500
      });

      return completion.choices[0]?.message?.content || "No response generated.";
    } catch (err) {
      console.warn(`⚠️ OpenRouter API Key index ${currentKeyIndex} failed: ${err.message}. Rotating key...`);
      lastError = err;
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    }
  }
  throw lastError || new Error("All OpenRouter API keys failed.");
}

// --- Background Auto-Learning from Text ---
async function extractAndLearnFact(messageText) {
  if (!messageText || messageText.length < 10 || messageText.startsWith(".")) return;

  try {
    const extractionPrompt = `
      You are an automated knowledge extractor for a business WhatsApp bot.
      Analyze the message below to see if it contains a clear, reusable business fact, price, service rule, policy, or common inquiry pattern.

      - Message: "${messageText}"

      Rules:
      1. If the message states or implies a clear business fact/rule/price, return ONLY the concise factual statement.
      2. If it is just casual greeting or temporary personal banter, return EXACTLY "NONE".
      3. Do NOT add explanation or quotes. Return ONLY the factual statement or NONE.
    `;

    const extractedFact = await callOpenRouterGemini(extractionPrompt, "Extract fact if present.");
    const cleanFact = extractedFact ? extractedFact.trim() : "NONE";

    if (cleanFact !== "NONE" && cleanFact.length > 5 && !cleanFact.includes("NONE")) {
      const knowledge = loadKnowledge();
      const exists = knowledge.some(existing => existing.toLowerCase() === cleanFact.toLowerCase());
      if (!exists) {
        knowledge.push(cleanFact);
        saveKnowledge(knowledge);
        console.log(`🧠 [Quiet Auto-Learned Fact]: "${cleanFact}"`);
      }
    }
  } catch (err) {
    console.error("Text auto-learning error:", err.message);
  }
}

// --- Background Auto-Archiving from Images via OpenRouter Vision ---
async function archiveMediaWithAutoInstruction(imageMessage, captionText) {
  try {
    const stream = await downloadContentFromMessage(imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    
    const fileName = `media_${Date.now()}.jpg`;
    const filePath = path.join(MEDIA_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    let instruction = captionText ? captionText.replace(/^\.remember\s*/i, "").trim() : "";
    const base64Image = buffer.toString("base64");

    if (!instruction) {
      const visionPrompt = "Describe this image concisely so a bot knows when to send it to customers (e.g. \"Science Department Timetable 2026\", \"Price list flyer\"). Return ONLY the short description.";
      const description = await callOpenRouterVision("You are a helpful media archivist.", base64Image, visionPrompt);
      instruction = description ? description.trim() : "Important business image";
    }

    const mediaVault = loadMediaKnowledge();
    mediaVault.push({
      path: filePath,
      instruction: instruction
    });

    saveMediaKnowledge(mediaVault);
    console.log(`📸 [Media Vault Auto-Saved via OpenRouter]: "${instruction}" -> ${filePath}`);
    return instruction;
  } catch (err) {
    console.error("Media auto-archival error:", err.message);
    return null;
  }
}

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
      console.log("✅ Personal Multi-AI WhatsApp Bot Active with Robust Tagging & Auto-Sleep!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg?.message) continue;

      const jid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;
      const myNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
      const isSelfChat = jid.includes(myNumber);
      const isGroup = jid.endsWith('@g.us');

      // 1. Universal Disappearing Messages Reset
      if (!isFromMe && !state.checkedChats.has(jid)) {
        try {
          await sock.sendMessage(jid, { disappearingMessagesInChat: false });
          state.checkedChats.add(jid);
        } catch (err) {}
      }

      if (msg.messageStubType) {
        const isEphemeralChange = (msg.messageStubType === 1 || msg.messageStubType === 68);
        if (isEphemeralChange && !isFromMe) {
          try {
            await sock.sendMessage(jid, { disappearingMessagesInChat: false });
          } catch (err) {}
        }
      }

      // Read Receipts (Blue ticks)
      if (!isFromMe) {
        await sock.readMessages([msg.key]);
      }

      const text = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        msg.message.imageMessage?.caption || 
        "";

      // 2. OWNER ACTIONS
      if (isFromMe) {
        const hasImage = msg.message?.imageMessage;

        if (text.startsWith(".")) {
          if (hasImage) {
            const savedInstruction = await archiveMediaWithAutoInstruction(hasImage, text);
            if (savedInstruction) {
              await sock.sendMessage(jid, { text: `✅ *Image Saved to Media Vault!* Instruction:\n"${savedInstruction}"` }, { quoted: msg });
            }
            continue;
          }

          const handledPublic = await handlePublicCommands(sock, msg, text, jid, isFromMe);
          if (handledPublic) continue;
          const handledAdmin = await handleAdminCommands(sock, msg, text, jid);
          if (handledAdmin) continue;
        }

        if (hasImage && isSelfChat) {
          const savedInstruction = await archiveMediaWithAutoInstruction(hasImage, text);
          if (savedInstruction) {
            await sock.sendMessage(jid, { text: `📸 *Auto-Archived to Media Vault:* "${savedInstruction}"` }, { quoted: msg });
          }
          continue;
        }

        if (text && isSelfChat && !text.startsWith(".")) {
          extractAndLearnFact(text).catch(e => console.error(e));
          continue;
        }

        continue;
      }

      if (!text && !msg.message?.imageMessage) continue;

      // 3. TAG-TO-ENGAGE LOGIC WITH ROBUST MATCHING & INACTIVITY AUTO-SLEEP
      const isTagged = isBotMentioned(sock, msg, text);
      const now = Date.now();

      // Expire inactive group sessions after 10 minutes
      if (state.activeConversations.has(jid)) {
        const lastActiveTime = state.activeConversations.get(jid);
        if (now - lastActiveTime > INACTIVITY_TIMEOUT) {
          state.activeConversations.delete(jid);
        }
      }

      // Wake up the bot when explicitly tagged in a group
      if (isGroup && isTagged) {
        state.activeConversations.set(jid, now);
      }

      // Ignore ordinary messages when the group session is asleep
      if (isGroup && !isTagged && !state.activeConversations.has(jid)) {
        continue;
      }

      // Refresh the timer during an active group conversation
      if (isGroup && state.activeConversations.has(jid)) {
        state.activeConversations.set(jid, now);
      }

      // PRIVATE CHATS: Auto-reply when Away Mode is ON (No tag needed)
      if (!isGroup && !state.isAway) {
        continue;
      }

      // 4. CLIENT CHAT QUIET LEARNING (20% Sample Rate)
      if (!isFromMe && text && !text.startsWith(".")) {
        if (Math.random() < 0.20) {
          extractAndLearnFact(text).catch(e => console.error(e));
        }
      }

      if (text.startsWith(".")) {
        const handledPublic = await handlePublicCommands(sock, msg, text, jid, isFromMe);
        if (handledPublic) continue;
      }

      // Check if muted
      if (state.mutedChats.has(jid)) continue;

      // Handle Incoming Customer Images with OpenRouter Vision
      const hasImage = msg.message?.imageMessage;
      if (hasImage && state.isAway) {
        await handleOpenRouterVisionResponse(sock, msg, hasImage, text || "Describe this image", jid);
        continue;
      }

      // Handle Text AI Response
      if (state.isAway && text) {
        await handleAIResponse(sock, msg, text, jid);
      }
    }
  });
}

/**
 * Public Commands Handler (.imagine, .image, .menu, .unmute)
 */
async function handlePublicCommands(sock, msg, text, jid, isFromMe) {
  const command = text.trim().toLowerCase();

  if (command === ".menu" || command === ".help") {
    const awayStatus = state.isAway ? "🟢 ON" : "🔴 OFF";
    const isMuted = state.mutedChats.has(jid) ? "🔇 MUTED" : "🔊 UNMUTED";

    let menuText = `🤖 *MULTI-AI WHATSAPP BOT*

🎨 *Public Commands:*
▫️ \`.imagine [prompt]\` - Generate image via Puter AI
▫️ \`.unmute\` - Unmute bot in this chat
▫️ \`.menu\` - Display available commands`;

    if (isFromMe) {
      menuText += `\n\n⚙️ *Owner Settings:*
- Away Mode: ${awayStatus}
- Chat Status: ${isMuted}

🛠️ *Owner Admin & Memory Commands:*
▫️ \`.knowledge\` - View all saved text facts
▫️ \`.media\` - View all archived images in vault
▫️ \`.remember [fact]\` - Manually teach bot a fact
▫️ \`.forget [number]\` - Delete a saved fact
▫️ \`.vv\` - Reply to View-Once media
▫️ \`.away on/off\` - Toggle away auto-responder
▫️ \`.mute / .unmute\` - Mute/Unmute chat
▫️ \`.block / .unblock\` - Block/Unblock contact`;
    }

    menuText += `\n\n🌟 *Core Engines:*
▫️ *Text & Vision:* Google Gemini via OpenRouter
▫️ *Images:* Puter AI Engine`;

    await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
    return true;
  }

  if (command === ".unmute") {
    state.mutedChats.delete(jid);
    await sock.sendMessage(jid, { text: "🔊 Bot unmuted for this chat." }, { quoted: msg });
    return true;
  }

  if (command.startsWith(".imagine ") || command.startsWith(".image ")) {
    const prompt = text.replace(/^\.(imagine|image)\s+/i, "").trim();
    if (!prompt) {
      await sock.sendMessage(jid, { text: "❌ Please provide a prompt. Example: `.imagine a futuristic Lagos city`" }, { quoted: msg });
      return true;
    }

    await sock.sendMessage(jid, { react: { text: '🎨', key: msg.key } });
    await sock.sendPresenceUpdate('composing', jid);

    try {
      const imageElement = await puter.ai.txt2img(prompt);
      const imageUrl = imageElement.src || imageElement.url;

      if (!imageUrl) throw new Error("No image URL returned.");

      await sock.sendPresenceUpdate('paused', jid);
      await sock.sendMessage(jid, { 
        image: { url: imageUrl }, 
        caption: `🎨 *Generated Image*\nPrompt: "${prompt}"` 
      }, { quoted: msg });
    } catch (err) {
      console.error("Image generation error:", err);
      await sock.sendPresenceUpdate('paused', jid);
      await sock.sendMessage(jid, { text: "❌ Failed to generate image. Please try again." }, { quoted: msg });
    }
    return true;
  }

  return false;
}

/**
 * Admin & Knowledge Base Commands Handler (.remember, .knowledge, .forget)
 */
async function handleAdminCommands(sock, msg, text, jid) {
  const commandLower = text.trim().toLowerCase();

  if (commandLower.startsWith(".remember")) {
    const fact = text.replace(/^\.remember\s*/i, "").trim();
    if (!fact) {
      await sock.sendMessage(jid, { text: "❌ Please provide a fact to remember. Example: `.remember Pen is 2k`" }, { quoted: msg });
      return true;
    }

    const knowledge = loadKnowledge();
    knowledge.push(fact);
    saveKnowledge(knowledge);

    await sock.sendMessage(jid, { text: `✅ *Fact Saved to Memory!* (${knowledge.length} total facts)\n"${fact}"` }, { quoted: msg });
    return true;
  }

  if (commandLower === ".knowledge" || commandLower === ".facts") {
    const knowledge = loadKnowledge();
    if (knowledge.length === 0) {
      await sock.sendMessage(jid, { text: "📂 Memory is empty. Use `.remember [fact]` or chat in your Self-Chat." }, { quoted: msg });
      return true;
    }

    const listText = knowledge.map((item, idx) => `*${idx + 1}.* ${item}`).join("\n");
    await sock.sendMessage(jid, { text: `📂 *Saved Text Knowledge Base:*\n\n${listText}\n\n_To delete an entry, type .forget [number]_` }, { quoted: msg });
    return true;
  }

  if (commandLower === ".media" || commandLower === ".vault") {
    const mediaVault = loadMediaKnowledge();
    if (mediaVault.length === 0) {
      await sock.sendMessage(jid, { text: "📂 Media vault is empty. Send screenshots or flyers in your Self-Chat." }, { quoted: msg });
      return true;
    }

    const listText = mediaVault.map((item, idx) => `*${idx + 1}.* ${item.instruction} (${path.basename(item.path)})`).join("\n");
    await sock.sendMessage(jid, { text: `📸 *Archived Media Vault:*\n\n${listText}\n\n_The bot will automatically send these images when clients ask about them._` }, { quoted: msg });
    return true;
  }

  if (commandLower.startsWith(".forget")) {
    const indexStr = text.replace(/^\.forget\s*/i, "").trim();
    const index = parseInt(indexStr) - 1;
    const knowledge = loadKnowledge();

    if (isNaN(index) || index < 0 || index >= knowledge.length) {
      await sock.sendMessage(jid, { text: "❌ Invalid or missing number. Usage: `.forget 1` (Type `.knowledge` to view list)." }, { quoted: msg });
      return true;
    }

    const removed = knowledge.splice(index, 1);
    saveKnowledge(knowledge);

    await sock.sendMessage(jid, { text: `🗑️ *Removed from memory:* "${removed[0]}"` }, { quoted: msg });
    return true;
  }

  if (commandLower === ".vv" || commandLower === ".viewonce") {
    const loadEmojis = ['⏳', '🔓', '👁️'];
    for (const emoji of loadEmojis) {
      await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    }
    
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      await sock.sendMessage(jid, { text: "❌ Please reply to a View-Once message with .vv" }, { quoted: msg });
      return true;
    }

    const viewOnce = quoted.viewOnceMessageV2 || quoted.viewOnceMessage || quoted.viewOnceMessageV2Extension;
    const message = viewOnce ? viewOnce.message : quoted;
    let vType = Object.keys(message)[0];

    if (['imageMessage', 'videoMessage', 'audioMessage'].includes(vType)) {
      try {
        const stream = await downloadContentFromMessage(message[vType], vType.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        
        if (vType === 'imageMessage') {
          await sock.sendMessage(jid, { image: buffer, caption: "✅ View-Once Image Downloaded" }, { quoted: msg });
        } else if (vType === 'videoMessage') {
          await sock.sendMessage(jid, { video: buffer, caption: "✅ View-Once Video Downloaded" }, { quoted: msg });
        } else if (vType === 'audioMessage') {
          await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
        }
      } catch (e) {
        await sock.sendMessage(jid, { text: "❌ Failed to download View-Once media." }, { quoted: msg });
      }
    } else {
      await sock.sendMessage(jid, { text: "❌ Not a View-Once media message." }, { quoted: msg });
    }
    return true;
  }

  if (commandLower.startsWith(".block")) {
    const targetJid = msg.message.extendedTextMessage?.contextInfo?.participant || jid;
    await sock.updateBlockStatus(targetJid, "block");
    await sock.sendMessage(jid, { text: "🚫 User blocked." }, { quoted: msg });
    return true;
  }
  
  if (commandLower.startsWith(".unblock")) {
    const targetJid = msg.message.extendedTextMessage?.contextInfo?.participant || jid;
    await sock.updateBlockStatus(targetJid, "unblock");
    await sock.sendMessage(jid, { text: "✅ User unblocked." }, { quoted: msg });
    return true;
  }

  if (commandLower === ".away on") {
    state.isAway = true;
    await sock.sendMessage(jid, { text: "🌙 Away mode activated. Bot will auto-reply." }, { quoted: msg });
    return true;
  }
  if (commandLower === ".away off") {
    state.isAway = false;
    await sock.sendMessage(jid, { text: "☀️ Away mode deactivated. Bot will stay quiet." }, { quoted: msg });
    return true;
  }

  if (commandLower === ".mute") {
    state.mutedChats.add(jid);
    await sock.sendMessage(jid, { text: "🔇 Bot muted for this chat." }, { quoted: msg });
    return true;
  }

  return false;
}

/**
 * OpenRouter Gemini Text Response with Smart Puter AI Generation & Media Vault Dispatch
 */
async function handleAIResponse(sock, msg, text, jid) {
  try {
    await sock.sendPresenceUpdate('composing', jid);

    const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    const currentDate = new Date().toLocaleDateString();

    const knowledgeBase = loadKnowledge();
    const knowledgeContext = knowledgeBase.length > 0
      ? `\n- BUSINESS KNOWLEDGE BASE (Facts & Prices):\n  ${knowledgeBase.map((k, i) => `${i + 1}.${k}`).join('\n  ')}`
      : '\n- BUSINESS KNOWLEDGE BASE: None recorded.';

    const mediaVault = loadMediaKnowledge();
    const mediaContext = mediaVault.length > 0
      ? `\n- ARCHIVED MEDIA VAULT (Images/Screenshots you can send when requested):\n  ${mediaVault.map((m, i) => `[Index: ${i}] Instruction/Rule: "${m.instruction}" \vert{} FilePath: "${m.path}"`).join('\n  ')}`
      : '\n- ARCHIVED MEDIA VAULT: None available.';

    const systemInstruction = `
      You are a personal WhatsApp AI assistant powered by Google Gemini via OpenRouter, replying on behalf of your owner who is currently away.
      - Context: Current Date is ${currentDate}, Current Time is ${currentTime}.
      ${knowledgeContext}
      ${mediaContext}

      CRITICAL CONVERSATIONAL RULES:
      - BREVITY IS MANDATORY: Keep your response under 1 to 3 sentences maximum. Be clear, concise, and direct.
      - FRIENDLY ON GREETINGS: If the user greets you (e.g., "hi", "hello", "gm", "good morning"), respond in a warm, brief, conversational way (1 sentence).
      - SILENCE ON PURE ACKNOWLEDGMENTS: If the user just sends a closing acknowledgment (e.g., "ok", "thanks", "noted", "thumbs up"), return EXACTLY "NONE" so the bot stays silent.

      ACTION TRIGGERS:
      - Media Vault Recall: If the request matches an item in ARCHIVED MEDIA VAULT, output EXACTLY this JSON on line 1: {"sendImage": true, "path": "<FilePath>", "caption": "<Very short response text>"}
      - Smart Image Generation: If explicitly asked to generate, draw, or design an image/flyer, output EXACTLY this JSON on line 1: {"generateImage": true, "prompt": "<detailed prompt>", "caption": "<Very short response text>"}

      FORMATTING:
      - Strictly use Unicode text characters (x², √, 1/2, ±, ≠) for math. NEVER use LaTeX syntax or dollar signs ($).
      - If user speaks another language, include a brief translation like "[Translation: ...]" at the start.
    `;

    const rawResponse = await callOpenRouterGemini(systemInstruction, text);
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    await sock.sendPresenceUpdate('paused', jid);

    const trimmedResponse = rawResponse ? rawResponse.trim() : "";

    if (!trimmedResponse || trimmedResponse === "NONE" || trimmedResponse.includes("NONE")) {
      return;
    }

    let handledAction = false;

    if (trimmedResponse.startsWith("{") && trimmedResponse.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmedResponse);

        if (parsed.sendImage && parsed.path && fs.existsSync(parsed.path)) {
          const imageBuffer = fs.readFileSync(parsed.path);
          await sock.sendMessage(jid, { 
            image: imageBuffer, 
            caption: parsed.caption || "Here is the requested image." 
          }, { quoted: msg });
          handledAction = true;
        } 
        else if (parsed.generateImage && parsed.prompt) {
          await sock.sendMessage(jid, { react: { text: '🎨', key: msg.key } });
          await sock.sendPresenceUpdate('composing', jid);

          const imageElement = await puter.ai.txt2img(parsed.prompt);
          const imageUrl = imageElement.src || imageElement.url;

          if (!imageUrl) throw new Error("No image URL returned from Puter AI.");

          await sock.sendPresenceUpdate('paused', jid);
          await sock.sendMessage(jid, { 
            image: { url: imageUrl }, 
            caption: parsed.caption || `🎨 *Generated Image*\nPrompt: "${parsed.prompt}"` 
          }, { quoted: msg });
          handledAction = true;
        }
      } catch (e) {
        console.error("Failed to parse dynamic AI action JSON:", e.message);
      }
    }

    if (!handledAction && rawResponse) {
      let cleanText = rawResponse;
      try {
        const parsed = JSON.parse(trimmedResponse);
        if (parsed.caption) cleanText = parsed.caption;
      } catch (e) {}

      await sock.sendMessage(jid, { text: cleanText }, { quoted: msg });
    }
  } catch (err) {
    console.error("OpenRouter Gemini error:", err);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}

/**
 * OpenRouter Vision Handler for Incoming Customer Images
 */
async function handleOpenRouterVisionResponse(sock, msg, imageMessage, promptText, jid) {
  try {
    await sock.sendPresenceUpdate('composing', jid);

    const stream = await downloadContentFromMessage(imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

    const base64Image = buffer.toString("base64");
    const systemPrompt = "You are a personal AI assistant replying on behalf of your owner who is currently away. Answer the user prompt regarding the attached image accurately, concisely, and use Unicode for math.";
    
    const responseText = await callOpenRouterVision(systemPrompt, base64Image, promptText);

    await new Promise(resolve => setTimeout(resolve, 2000));
    await sock.sendPresenceUpdate('paused', jid);

    if (responseText) {
      await sock.sendMessage(jid, { text: responseText }, { quoted: msg });
    }
  } catch (err) {
    console.error("OpenRouter Vision error:", err);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sock.sendMessage(jid, { text: "❌ Failed to analyze the image." }, { quoted: msg });
  }
}

// Start Express Server & Bot Socket
app.listen(PORT, () => {
  console.log(`🚀 Web Dashboard running on port ${PORT}`);
  startBot();
});
