import fs from "fs/promises";
import path from "path";
import { gzipSync, gunzipSync } from "zlib";
import { google } from "googleapis";

const TAB = "_WhatsAppSession";
const CHUNK_SIZE = 45000;
const configured = () => Boolean(process.env.GOOGLE_CLIENT_EMAIL && (process.env.GOOGLE_PRIVATE_KEY_B64 || process.env.GOOGLE_PRIVATE_KEY) && process.env.GOOGLE_SHEET_ID);

function privateKey() {
  if (process.env.GOOGLE_PRIVATE_KEY_B64) return Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, "base64").toString("utf8");
  return (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function client() {
  const auth = new google.auth.JWT({ email: process.env.GOOGLE_CLIENT_EMAIL, key: privateKey(), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth });
}

async function ensureTab(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  if (metadata.data.sheets?.some((sheet) => sheet.properties?.title === TAB)) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: TAB, hidden: true } } }] } });
}

async function readFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = {};
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".json")) files[entry.name] = await fs.readFile(path.join(directory, entry.name), "utf8");
  return files;
}

export async function restoreSession(directory) {
  if (!configured()) { console.log("Remote WhatsApp session backup is not configured."); return false; }
  const sheets = client();
  await ensureTab(sheets);
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${TAB}!A2:A` });
  const encoded = (response.data.values || []).map((row) => row[0] || "").join("");
  if (!encoded) return false;
  const files = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(directory, path.basename(name)), contents, "utf8")));
  console.log(`Restored WhatsApp session (${Object.keys(files).length} files).`);
  return true;
}

export async function backupSession(directory) {
  if (!configured()) return false;
  const files = await readFiles(directory);
  if (!files["creds.json"]) return false;
  const encoded = gzipSync(JSON.stringify(files)).toString("base64");
  const chunks = encoded.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "g")) || [];
  const sheets = client();
  await ensureTab(sheets);
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${TAB}!A2:A` });
  await sheets.spreadsheets.values.update({ spreadsheetId, range: `${TAB}!A2`, valueInputOption: "RAW", requestBody: { values: chunks.map((chunk) => [chunk]) } });
  console.log(`Backed up WhatsApp session (${Object.keys(files).length} files).`);
  return true;
}

export async function clearSessionBackup() {
  if (!configured()) return;
  const sheets = client();
  await ensureTab(sheets);
  await sheets.spreadsheets.values.clear({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${TAB}!A2:A` });
}
