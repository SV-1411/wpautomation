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
import pino from "pino";
import "dotenv/config";
import { runAgent } from "./lib/brain.js";

const TRIGGER = (process.env.TRIGGER_COMMAND || "/agent").toLowerCase();
const ALLOWLIST = (process.env.ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
const logger = pino({ level: "warn" });

const histories = new Map(); // jid -> messages[] (without system)
const active = new Set();     // jids currently engaged with the agent

// ── tiny health server so Render sees an open port + uptime pingers keep us awake ──
http.createServer((req, res) => { res.writeHead(200); res.end("ok"); })
  .listen(process.env.PORT || 3000, () => console.log("health server on", process.env.PORT || 3000));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\n📲 Scan in WhatsApp → Linked devices → Link a device:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log(`✅ Connected. Agent waits for "${TRIGGER}" before replying.`);
    if (connection === "close") {
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
