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
let latestQR = null;          // current pairing QR string
let connected = false;

// ── health + scannable-QR server. Open <url>/qr in a browser to link WhatsApp. ──
http.createServer(async (req, res) => {
  if (req.url === "/qr") {
    if (connected) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<body style='font-family:sans-serif;text-align:center;padding:40px'><h2>✅ WhatsApp is connected</h2></body>"); }
    if (!latestQR) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<meta http-equiv=refresh content=3><body style='font-family:sans-serif;text-align:center;padding:40px'><h2>Starting… waiting for QR</h2><p>This page refreshes automatically.</p></body>"); }
    const img = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!doctype html><meta http-equiv=refresh content=8><body style="font-family:sans-serif;text-align:center;padding:30px"><h2>Scan with WhatsApp</h2><p>WhatsApp → ⋮ → Linked devices → Link a device</p><img src="${img}" width="320" height="320"/><p style="color:#888">Page auto-refreshes; always scan the latest code.</p></body>`);
  }
  res.writeHead(200); res.end("ok");
}).listen(process.env.PORT || 3000, () => console.log("health+QR server on", process.env.PORT || 3000, "— open /qr to scan"));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger });

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
