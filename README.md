# BrightSmile Dental — AI Receptionist 🦷

An AI receptionist that chats with patients and **books real appointments** into Google
Calendar + Sheets. Two front-ends, one shared brain:

- **Web demo** (`/public` + `/api`) → deploys to **Vercel**, public URL to show a client.
- **WhatsApp** (`index.js`) → runs locally / on an always-on host (NOT Vercel).

Brain = OpenRouter (free `nvidia/nemotron-3-super-120b-a12b:free` by default).

---

## 1. Run the web demo locally (30 sec)

```powershell
cd D:\whatsapp-agent
npm install
npm run dev          # → http://localhost:3000
```

Open http://localhost:3000 — a WhatsApp-style chat. Try the quick buttons or
"book a whitening tomorrow at 5pm". Bookings are **simulated** until you add Google creds
(step 3). Screen-record this for the client.

---

## 2. Deploy the web demo to Vercel (public link)

```powershell
npm i -g vercel          # once
cd D:\whatsapp-agent
vercel login             # opens browser — run this yourself
vercel                   # first deploy (accept defaults) → preview URL
vercel --prod            # production URL to send the client
```

Then add env vars so the deployed site has the key (do NOT rely on .env — Vercel ignores it):

```powershell
vercel env add OPENROUTER_API_KEY production   # paste the sk-or-v1-... key
vercel env add MODEL production                # nvidia/nemotron-3-super-120b-a12b:free
# (after adding Google creds in step 3, add those the same way, then re-deploy)
vercel --prod
```

> No framework, zero build. `vercel.json` rewrites `/` → the chat page; `/api/chat` is a
> serverless function. The browser keeps the conversation and sends it each turn, so it's
> fully stateless (Vercel-friendly).

---

## 3. Connect Google Calendar + Sheets (real bookings)

Uses a **service account** (a robot Google login) — no OAuth popups, works on a server.

**A. Make the service account**
1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → Library** → enable **Google Calendar API** and **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account** → name it → Done.
4. Open it → **Keys → Add key → JSON** → downloads a `*.json` file. Inside you'll find
   `client_email` and `private_key`.

**B. Share your real Calendar + Sheet with the robot**
- **Calendar:** Google Calendar → your calendar → Settings → *Share with specific people* →
  add the `client_email` → permission **Make changes to events**. Copy the **Calendar ID**
  (Settings → Integrate calendar) — usually your gmail, or use `primary`.
- **Sheet:** make a Google Sheet with a tab named **Appointments** and headers in row 1:
  `Timestamp | Name | Phone | Service | DateTime | Notes`. Click **Share** → add the
  `client_email` as **Editor**. Copy the **Sheet ID** from its URL
  (`docs.google.com/spreadsheets/d/<THIS_PART>/edit`).

**C. Put creds in env** — local `.env` and (for the live site) Vercel:
```
GOOGLE_CLIENT_EMAIL=...@...iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=primary           # or the calendar id you copied
GOOGLE_SHEET_ID=...                  # the sheet id
```
The private key must keep its `\n` markers (paste it exactly as in the JSON, in quotes).

Restart (`npm run dev`) — now "book me a cleaning tomorrow at 11am" creates a **real
Calendar event** and appends a **row in the Sheet**. To put it live, add the same vars with
`vercel env add ... production` and run `vercel --prod`.

---

## 4. Run it on real WhatsApp (number 9623688451)

The WhatsApp bot is **gated** and **simulates bookings** (never writes to the real
calendar/sheet — set in `index.js`). It stays SILENT until a chat sends the trigger:

- `/agent` → activates the receptionist for that chat (greets, then chats + books-in-demo)
- `/stop`  → deactivates for that chat
- `/reset` → clears that chat's memory

So your normal contacts who text you get **no** bot reply — only people who send `/agent`.

### Run locally
```powershell
npm run whatsapp     # prints a QR
```
Scan with the phone holding the number: WhatsApp → **Linked devices → Link a device**.
Then from another phone, message the number and send `/agent` to start.

### Always-on on Render
1. Push this repo to GitHub: `gh auth login` then
   `gh repo create brightsmile-whatsapp --private --source=. --push`
2. On [render.com](https://render.com) → **New → Web Service** → connect the repo. It reads
   `render.yaml` automatically (free plan, `node index.js`, health check `/`).
3. Add the secret env var **OPENROUTER_API_KEY** in the Render dashboard (the rest come from
   `render.yaml`: MODEL, SIMULATE_BOOKINGS=true, TRIGGER_COMMAND=/agent, CLINIC_*).
4. Deploy → open **Logs** → an ASCII **QR** prints → scan it with the number's phone.
5. Keep it awake: add a free monitor at [cron-job.org](https://cron-job.org) /
   [uptimerobot.com](https://uptimerobot.com) pinging your Render URL every 10 min.

> Free Render caveat: ephemeral disk → after a restart/redeploy you must re-scan the QR.
> Add a Render **persistent disk** (~$1/mo) mounted at `/opt/render/project/src/auth`, or run
> on your own PC (below), to avoid re-scanning.

### Always-on on your own PC ($0, no re-scan)
```powershell
npm i -g pm2
cd D:\whatsapp-agent
pm2 start index.js --name whatsapp-agent
pm2 save
pm2 startup     # follow the printed line so it auto-starts with Windows
```
Auth persists on local disk, so crashes/restarts reconnect without a new QR.

---

## Customize
- **Clinic name / address / hours / services** → `.env` (`CLINIC_*`) and `lib/tools.js`.
- **Personality + booking rules** → `SYSTEM_PROMPT` in `lib/tools.js`.
- **Add abilities** (cancel/reschedule, price quotes, reminders) → add tools in `lib/tools.js`.
- **Cheaper/smarter model** → `MODEL` in `.env` / Vercel. Free Nemotron caps ~50 msgs/day
  under $10 credit; a one-time $10 on OpenRouter lifts it to ~1000/day.

## Files
```
public/index.html   web chat UI (dental branded)
api/chat.js         Vercel serverless endpoint
lib/brain.js        model + tool loop (stateless, shared)
lib/tools.js        dental tools + system prompt
lib/google.js       Calendar + Sheets booking (simulates if no creds)
index.js            real WhatsApp bot (Baileys)
demo-server.js      local server mirroring Vercel
vercel.json         routing
```
