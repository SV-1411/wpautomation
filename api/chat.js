// Vercel serverless function. Stateless: the browser sends the running history each turn.
import { runAgent } from "../lib/brain.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { messages = [] } = req.body || {};
    // Keep history bounded so token cost / latency stays low.
    const trimmed = messages.slice(-24);
    const { reply, messages: updated } = await runAgent(trimmed);
    res.status(200).json({ reply, messages: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "agent error" });
  }
}
