// Real WhatsApp connector (Baileys). Always-on, gated behind /agent, bookings SIMULATED.
// Runs on Render (or anywhere). One QR scan links the number; the agent only engages a chat
// after that chat sends /agent — so your normal contacts never get bot replies.
process.env.SIMULATE_BOOKINGS = "true"; // WhatsApp never writes to the real calendar/sheet

import http from "http";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import "dotenv/config";
import { runAgent } from "./lib/brain.js";

const TRIGGER = (process.env.TRIGGER_COMMAND || "/agent").toLowerCase();
const ALLOWLIST = (process.env.ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
const logger = pino({ level: "warn" });

const histories = new Map(); // jid -> messages[] (without system)
const active = new Set();     // jids currently engaged with the agent
const PAIR_NUMBER = (process.env.PAIR_NUMBER || "").replace(/[^0-9]/g, ""); // e.g. 919623688451
let latestQR = null;          // current pairing QR string
let pairingCode = null;       // 8-char "link with phone number" code
let connected = false;
let pairingAsked = false;
let currentSock = null;       // live socket, so the watchdog can recycle it for a fresh code

// Watchdog: while unpaired, recycle the socket every ~100s so the displayed code never expires.
setInterval(() => {
  try {
    if (!connected && PAIR_NUMBER && currentSock && !currentSock.authState?.creds?.registered) {
      console.log("♻️  refreshing pairing code…");
      currentSock.end(new Error("refresh-pairing"));
    }
  } catch {}
}, 100000);

const page = (inner, refresh = true) =>
  `<!doctype html>${refresh ? "<meta http-equiv=refresh content=8>" : ""}<body style="font-family:sans-serif;text-align:center;padding:30px">${inner}</body>`;

// ── health + pairing server. Open <url>/qr in a browser to link WhatsApp. ──
http.createServer(async (req, res) => {
  if (req.url === "/qr") {
    const head = { "Content-Type": "text/html" };
    if (connected) { res.writeHead(200, head); return res.end(page("<h2>✅ WhatsApp is connected</h2>", false)); }
    // Prefer the pairing CODE — far easier than scanning a screen QR.
    if (pairingCode) {
      const c = pairingCode.length === 8 ? pairingCode.slice(0, 4) + "-" + pairingCode.slice(4) : pairingCode;
      return res.writeHead(200, head), res.end(page(
        `<h2>Link with your phone number</h2>
         <p>On the <b>${PAIR_NUMBER || "agent"}</b> phone open WhatsApp →<br>⋮ / Settings → <b>Linked devices</b> → <b>Link a device</b> → <b>Link with phone number instead</b></p>
         <div style="font-size:42px;font-weight:700;letter-spacing:6px;margin:24px;font-family:monospace">${c}</div>
         <p style="color:#888">Type this code into WhatsApp. Page auto-refreshes.</p>`));
    }
    if (latestQR) {
      const img = await QRCode.toDataURL(latestQR, { width: 360, margin: 4, errorCorrectionLevel: "L" });
      return res.writeHead(200, head), res.end(page(
        `<h2>Scan with WhatsApp</h2><p>Linked devices → Link a device</p><img src="${img}" width="360" height="360"/>`));
    }
    res.writeHead(200, head); return res.end(page("<h2>Starting… generating code</h2><p>Refreshing…</p>"));
  }
  res.writeHead(200); res.end("ok");
}).listen(process.env.PORT || 3000, () => console.log("health+QR server on", process.env.PORT || 3000, "— open /qr to scan"));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger });
  currentSock = sock;

  // Pairing code: type an 8-char code into WhatsApp instead of scanning a QR (much more reliable).
  if (PAIR_NUMBER && !sock.authState.creds.registered && !pairingAsked) {
    pairingAsked = true;
    setTimeout(async () => {
      try {
        pairingCode = await sock.requestPairingCode(PAIR_NUMBER);
        console.log(`\n🔢 Pairing code for ${PAIR_NUMBER}: ${pairingCode}  — enter it in WhatsApp → Linked devices → Link with phone number.\n`);
      } catch (e) { console.log("pairing code error:", e?.message || e); pairingAsked = false; }
    }, 3000);
  }

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      latestQR = qr;
      console.log("\n📲 QR ready — open  <your-render-url>/qr  in a browser to scan it.\n");
      qrcode.generate(qr, { small: true }); // also print ASCII (works in a real terminal)
    }
    if (connection === "open") { connected = true; latestQR = null; console.log(`✅ Connected. Agent waits for "${TRIGGER}" before replying.`); }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // If still unpaired, let the next start() mint a FRESH pairing code (old ones expire).
      if (!sock.authState.creds.registered) { pairingAsked = false; pairingCode = null; }
      console.log(`⚠️  closed (${code}).` + (loggedOut ? " Delete ./auth and rescan." : " Reconnecting…"));
      if (!loggedOut) start();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;
        const number = jid.split("@")[0];
        if (ALLOWLIST.length && !ALLOWLIST.includes(number)) continue;

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        if (!text) continue;
        const cmd = text.toLowerCase();

        // ── command gate ──
        if (cmd === TRIGGER) {
          active.add(jid);
          histories.delete(jid);
          await sock.sendMessage(jid, { text: "👋 Hi! You're now chatting with the BrightSmile Dental AI receptionist. Ask me anything or tell me what appointment you'd like to book. (Send /stop to end.)" });
          continue;
        }
        if (cmd === "/stop") {
          active.delete(jid); histories.delete(jid);
          await sock.sendMessage(jid, { text: `👋 Okay, I'll step back. Send ${TRIGGER} anytime to chat again.` });
          continue;
        }
        if (cmd === "/reset") {
          histories.delete(jid);
          if (active.has(jid)) await sock.sendMessage(jid, { text: "🧠 Fresh start." });
          continue;
        }

        // Stay SILENT unless this chat has activated the agent.
        if (!active.has(jid)) continue;

        const hist = histories.get(jid) || [];
        hist.push({ role: "user", content: text });
        await sock.sendPresenceUpdate("composing", jid);
        const { reply, messages: updated } = await runAgent(hist.slice(-24));
        histories.set(jid, updated);
        await sock.sendMessage(jid, { text: reply });
        console.log(`💬 ${number}: ${text}  →  ${reply.slice(0, 50)}…`);
      } catch (e) {
        console.error("handler error:", e?.message || e);
      }
    }
  });
}
start();
