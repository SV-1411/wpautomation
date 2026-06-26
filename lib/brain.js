// Stateless agent core: takes a messages array, runs the tool loop, returns updated messages + reply.
// Used by both the Vercel API (history from client) and the local WhatsApp bot (history in RAM).
import OpenAI from "openai";
import { toolMap, toolSchemas, SYSTEM_PROMPT } from "./tools.js";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: { "X-Title": "Dental WhatsApp AI Agent" },
});

const MODEL = process.env.MODEL || "nvidia/nemotron-3-super-120b-a12b:free";

export function systemMessage() {
  const today = new Date().toISOString().slice(0, 10);
  return { role: "system", content: `${SYSTEM_PROMPT}\n\n(System: today is ${today}.)` };
}

// messages: array WITHOUT the system prompt (we prepend a fresh one each call so the date stays current).
// returns { reply, messages } where messages is the new history to persist (still without system).
export async function runAgent(messages) {
  const convo = [systemMessage(), ...messages];

  for (let step = 0; step < 6; step++) {
    const res = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: convo,
      tools: toolSchemas,
    });
    const msg = res.choices[0].message;
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return { reply: (msg.content || "…").trim(), messages: convo.slice(1) };
    }
    for (const call of calls) {
      let out;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        out = await (toolMap[call.function.name]?.(args) ?? { error: "unknown tool" });
      } catch (e) {
        out = { error: String(e?.message || e) };
      }
      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
    }
  }
  return { reply: "Sorry, I got a bit tangled — could you rephrase that?", messages: convo.slice(1) };
}
