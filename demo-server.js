// Local mirror of the Vercel setup: serves public/index.html + /api/chat.
// Use this to test/screen-record before (or instead of) deploying.
//   node demo-server.js  →  http://localhost:3000
import http from "http";
import { readFile } from "fs/promises";
import "dotenv/config";
import { runAgent } from "./lib/brain.js";

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const html = await readFile(new URL("./public/index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { messages = [] } = JSON.parse(body || "{}");
        const { reply, messages: updated } = await runAgent(messages.slice(-24));
        json(res, { reply, messages: updated });
      } catch (e) {
        json(res, { error: e?.message || String(e) }, 500);
      }
    });
    return;
  }
  res.writeHead(404).end();
});

function json(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
server.listen(PORT, () => console.log(`\n🟢 Dental demo live → http://localhost:${PORT}\n`));
