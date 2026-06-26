// Google Calendar + Sheets booking via a service account.
// If creds are missing, everything SIMULATES so the demo still works (great for the client preview).
import { google } from "googleapis";

// Checked at call-time (not load-time) so a caller can force simulation by setting the env first.
function isSimulated() {
  if (process.env.SIMULATE_BOOKINGS === "true") return true;
  return !(process.env.GOOGLE_CLIENT_EMAIL && (process.env.GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY_B64));
}
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const TZ = process.env.CLINIC_TZ || "Asia/Kolkata";

function privateKey() {
  // Prefer base64 (survives any env-var storage); fall back to raw PEM with \n escapes.
  if (process.env.GOOGLE_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, "base64").toString("utf8");
  }
  return (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function authClient() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey(),
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
}

// Parse "2026-07-02 16:00" (24h) → ISO start/end (default 30-min slot).
function slot(dateTime, minutes = 30) {
  const start = new Date(dateTime.replace(" ", "T"));
  const end = new Date(start.getTime() + minutes * 60000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export { isSimulated };

// Make sure an "Appointments" tab with headers exists, whatever the sheet was named.
async function ensureTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  if (titles.includes("Appointments")) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: "Appointments" } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Appointments!A1:F1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["Timestamp", "Name", "Phone", "Service", "DateTime", "Notes"]] },
  });
}

// Book: create a Calendar event + append a row to the leads/appointments Sheet.
export async function createBooking({ name, phone, service, dateTime, notes }) {
  if (isSimulated()) {
    return { ok: true, simulated: true, message: `(demo) would book ${service} for ${name} at ${dateTime}` };
  }
  const auth = authClient();
  const { start, end } = slot(dateTime);

  const calendar = google.calendar({ version: "v3", auth });
  const event = await calendar.events.insert({
    calendarId: CAL_ID,
    requestBody: {
      summary: `${service} — ${name}`,
      description: `Booked via WhatsApp AI agent\nPhone: ${phone || "n/a"}\nNotes: ${notes || "-"}`,
      start: { dateTime: start, timeZone: TZ },
      end: { dateTime: end, timeZone: TZ },
    },
  });

  if (SHEET_ID) {
    const sheets = google.sheets({ version: "v4", auth });
    await ensureTab(sheets);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Appointments!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toISOString(), name, phone || "", service, dateTime, notes || ""]] },
    });
  }
  return { ok: true, eventLink: event.data.htmlLink, message: `Booked ${service} for ${name} at ${dateTime}.` };
}

// Availability: ask Calendar which of the given candidate ISO times are free.
export async function checkAvailability({ candidates }) {
  if (isSimulated()) {
    return { ok: true, simulated: true, free: candidates };
  }
  const auth = authClient();
  const calendar = google.calendar({ version: "v3", auth });
  const free = [];
  for (const dt of candidates) {
    const { start, end } = slot(dt);
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin: start, timeMax: end, items: [{ id: CAL_ID }] },
    });
    const busy = fb.data.calendars?.[CAL_ID]?.busy || [];
    if (busy.length === 0) free.push(dt);
  }
  return { ok: true, free };
}
