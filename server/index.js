// Day One — zero-dependency Node server.
// Serves the static app from ../app and proxies chat to OpenAI gpt-4o.
// Run: node server/index.js   (needs OPENAI_API_KEY in .env or environment)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const PORT = process.env.PORT || 8771;

// --- tiny .env loader (no dependency) ---
function loadEnv() {
  const extra = process.env.DAYONE_ENV_PATH;
  const candidates = extra
    ? [extra, path.join(ROOT, ".env"), path.join(__dirname, ".env")]
    : [path.join(ROOT, ".env"), path.join(__dirname, ".env")];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      txt.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m && !process.env[m[1]]) {
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          process.env[m[1]] = v;
        }
      });
    } catch {}
  }
}
loadEnv();

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const JAMENDO_ID = process.env.JAMENDO_CLIENT_ID || "";

// Fallback playlist (royalty-free) used when no Jamendo key is set.
const FALLBACK_TRACKS = [
  { title: "Morning Drive", artist: "Motivation Mix", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", cover: "" },
  { title: "Momentum",      artist: "Motivation Mix", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3", cover: "" },
  { title: "Rise Up",       artist: "Motivation Mix", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3", cover: "" },
  { title: "Flow State",    artist: "Motivation Mix", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3", cover: "" },
];
let musicCache = { day: "", tracks: null }; // cache the daily playlist server-side

// --- static file serving ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(APP_DIR, path.normalize(pathname));
  if (!filePath.startsWith(APP_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

// --- AI tools the model may call to change the user's day ---
const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_task",
      description: "Fügt dem Tagesplan eine neue Aufgabe hinzu.",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "Uhrzeit HH:MM, z.B. 14:30" },
          title: { type: "string", description: "Kurzer Aufgabentitel" },
          duration: { type: "string", description: "Optionale Dauer, z.B. '30 min'" },
          note: { type: "string", description: "Optionale Notiz zur Aufgabe" },
        },
        required: ["time", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toggle_task",
      description: "Markiert eine bestehende Aufgabe als erledigt oder offen (per id).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Die id der Aufgabe aus dem Kontext" },
          done: { type: "boolean", description: "true = erledigt, false = offen" },
        },
        required: ["id", "done"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Entfernt eine Aufgabe (per id).",
      parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_note",
      description: "Ersetzt den Inhalt des Notizen-Widgets.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
];

function systemPrompt(context) {
  const { todos = [], notes = "", profile = {}, now = "", history = {}, observation = "" } = context || {};
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); } catch { return "?"; } };
  const taskLines = todos.length
    ? todos.map((t) => `- id ${t.id} | geplant ${t.time} | ${t.title}${t.duration ? " (" + t.duration + ")" : ""} | ${t.done ? "erledigt" + (t.doneAt ? " um " + fmtTime(t.doneAt) : "") : "offen"}`).join("\n")
    : "(noch keine Aufgaben)";
  const histLines = Object.keys(history).length
    ? Object.entries(history).sort().slice(-7).map(([d, p]) => `- ${d}: ${Math.round((p || 0) * 100)}% erledigt`).join("\n")
    : "(noch keine Verlaufsdaten)";
  return [
    "Du bist der persönliche Planungs-Assistent von „Day One“, einer ruhigen, minimalistischen Tagesplaner-App.",
    "Sprich Deutsch. Antworte kurz, klar und freundlich — keine Floskeln, kein Markdown, keine Listen-Symbole.",
    "",
    "DEINE AUFGABE — aktiv mitdenken, nicht nur zustimmen:",
    "- Wenn der Nutzer Vorhaben oder Ziele nennt, überlege selbst sinnvolle Uhrzeiten und realistische Dauern und schlage sie konkret vor (z. B. „Deep Work 90 min um 09:30“).",
    "- Berücksichtige die schon vorhandenen Aufgaben und die Routinen aus dem Profil. Vermeide Zeit-Überschneidungen. Plane Pausen/Puffer wenn sinnvoll.",
    "- Begründe deine Wahl in EINEM kurzen Satz (z. B. „Vormittags bist du fokussierter, daher der Deep-Work-Block früh.“).",
    "- Fehlt eine Angabe (Dauer, ungefähre Zeit), triff eine vernünftige Annahme statt nachzufragen — nur bei echter Unklarheit eine kurze Rückfrage.",
    "",
    "WICHTIG — Änderungen IMMER über die Tools ausführen:",
    "- Jede Planänderung MUSS per Tool passieren: add_task (mit time, title, möglichst duration), toggle_task, delete_task, set_note.",
    "- Reiner Text ohne Tool-Aufruf ändert NICHTS. Sag nie „ich habe hinzugefügt“, ohne add_task wirklich aufzurufen.",
    "- Mehrere Aufgaben = mehrere Tool-Aufrufe in einer Antwort.",
    "- Danach bestätige knapp, was du eingeplant hast.",
    "",
    `Aktuelles Datum & Uhrzeit: ${now || "unbekannt"}.`,
    "",
    "Du hast Zugriff auf ALLE App-Daten unten (Aufgaben inkl. Erledigungszeiten, Notizen, Profil, Verlauf). Beziehe sie aktiv ein:",
    "- Lies die NOTIZEN und behalte im Kopf, was sich der Nutzer vorgenommen hat.",
    "- Analysiere den VERLAUF und die Erledigungszeiten: Werden Aufgaben pünktlich (nahe der geplanten Zeit) erledigt? Sprich Muster/Probleme proaktiv an, wenn relevant.",
    "",
    "AKTUELLER TAGESPLAN (geplante Zeit vs. tatsächliche Erledigung):",
    taskLines,
    "",
    "NOTIZEN (was der Nutzer sich notiert hat):",
    notes || "(leer)",
    "",
    "VERLAUF (Erledigungsquote pro Tag):",
    histLines,
    "",
    "AKTUELLE KI-BEOBACHTUNG (deine bisherige Verhaltensanalyse — nutze sie, um Vorschläge daran anzupassen):",
    observation || "(noch keine)",
    "",
    "PROFIL:",
    `Name: ${profile.name || "-"}`,
    `Über mich: ${profile.about || "-"}`,
    `Ziele: ${profile.goals || "-"}`,
    `Routinen: ${profile.routines || "-"}`,
  ].join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleChat(req, res) {
  try {
    if (!OPENAI_KEY) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ reply: "Kein OPENAI_API_KEY gesetzt. Trag deinen Key in die Datei .env ein (siehe .env.example) und starte den Server neu.", actions: [] }));
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const userMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = [{ role: "system", content: systemPrompt(body.context) }, ...userMessages];

    const apiRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.4 }),
    });
    if (!apiRes.ok) {
      const errTxt = await apiRes.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ reply: `OpenAI-Fehler (${apiRes.status}): ${errTxt.slice(0, 300)}`, actions: [] }));
    }
    const data = await apiRes.json();
    const msg = data.choices?.[0]?.message || {};
    const actions = (msg.tool_calls || []).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      return { name: tc.function.name, args };
    });
    let reply = (msg.content || "").trim();
    if (!reply && actions.length) {
      reply = actions.map((a) =>
        a.name === "add_task" ? `Hinzugefügt: ${a.args.time} ${a.args.title}.` :
        a.name === "toggle_task" ? (a.args.done ? "Als erledigt markiert." : "Wieder als offen markiert.") :
        a.name === "delete_task" ? "Aufgabe entfernt." :
        a.name === "set_note" ? "Notiz aktualisiert." : "Erledigt."
      ).join(" ");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply: reply || "Ok.", actions }));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply: "Serverfehler: " + (e.message || String(e)), actions: [] }));
  }
}

// --- KI-Beobachtung: analyse the user's data and return short observations ---
async function handleObserve(req, res) {
  try {
    if (!OPENAI_KEY) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ observation: "Kein OPENAI_API_KEY gesetzt." }));
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const full = systemPrompt(body.context);
    const dataBlock = full.substring(full.indexOf("Aktuelles Datum")); // datetime + tasks + notes + history + profile
    const sys = [
      "Du bist die „KI-Beobachtung“ von Day One — du beobachtest die Gewohnheiten des Nutzers und berichtest darüber.",
      "Analysiere die Daten unten (Aufgaben mit geplanter vs. tatsächlicher Erledigungszeit, Verlauf der Erledigungsquote, Notizen, Profil/Routinen).",
      "Gib 1–3 sehr kurze, konkrete Beobachtungen über Gewohnheiten, Timing und Konsistenz (z. B. pünktlich vs. verspätet, starke/schwache Tageszeiten, wiederkehrende Muster, Fortschritt zu den Zielen).",
      "Sprich Deutsch, direkt und wohlwollend. Maximal 3 kurze Sätze. Kein Markdown, keine Aufzählungszeichen. Bei dünner Datenlage sag das knapp.",
      "",
      "DATEN:",
      dataBlock,
    ].join("\n");
    const apiRes = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: "Was beobachtest du an meinen Gewohnheiten?" }], temperature: 0.5 }),
    });
    if (!apiRes.ok) {
      const t = await apiRes.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ observation: `OpenAI-Fehler (${apiRes.status}).` }));
    }
    const data = await apiRes.json();
    const observation = (data.choices?.[0]?.message?.content || "").trim();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ observation }));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ observation: "Fehler: " + (e.message || String(e)) }));
  }
}

// --- Motivational music via Jamendo (free, legal CC). One playlist/day, cached. ---
const todayStr = () => new Date().toISOString().slice(0, 10);
async function handleMusic(req, res) {
  const send = (tracks, source) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tracks, source }));
  };
  try {
    if (musicCache.day === todayStr() && musicCache.tracks) return send(musicCache.tracks, "cache");
    if (!JAMENDO_ID) { musicCache = { day: todayStr(), tracks: FALLBACK_TRACKS }; return send(FALLBACK_TRACKS, "fallback"); }
    const params = new URLSearchParams({
      client_id: JAMENDO_ID, format: "json", limit: "40",
      tags: "rock", include: "musicinfo",
      audioformat: "mp32", order: "popularity_total", speed: "high+veryhigh",
    });
    const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params.toString()}`);
    const j = await r.json();
    const tracks = (j.results || []).filter(t => t.audio).map(t => ({
      title: t.name, artist: t.artist_name, url: t.audio,
      cover: t.album_image || t.image || "", dur: Number(t.duration) || 0,
    }));
    const list = tracks.length ? tracks : FALLBACK_TRACKS;
    musicCache = { day: todayStr(), tracks: list };
    send(list, tracks.length ? "jamendo" : "fallback");
  } catch (e) {
    send(FALLBACK_TRACKS, "error");
  }
}

// --- Whisper Transkription ---
async function handleTranscribe(req, res) {
  try {
    if (!OPENAI_KEY) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: "", error: "Kein OPENAI_API_KEY gesetzt." }));
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const { audio, mimeType = "audio/webm" } = body;
    if (!audio) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: "", error: "Kein Audio" }));
    }

    const audioBuffer = Buffer.from(audio, "base64");
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `audio.${ext}`;
    const boundary = "----DayOneWhisper" + Date.now();

    // Multipart form-data manuell bauen (keine extra Dependencies)
    const partHead = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const modelPart = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `de\r\n` +
      `--${boundary}--\r\n`
    );
    const formData = Buffer.concat([partHead, audioBuffer, modelPart]);

    const apiRes = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: formData,
    });

    if (!apiRes.ok) {
      const t = await apiRes.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: "", error: `Whisper ${apiRes.status}: ${t.slice(0, 200)}` }));
    }
    const data = await apiRes.json();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: data.text || "" }));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "", error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/observe") return handleObserve(req, res);
  if (req.method === "POST" && req.url === "/api/transcribe") return handleTranscribe(req, res);
  if (req.method === "GET" && req.url === "/api/music") return handleMusic(req, res);
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, model: MODEL, keySet: !!OPENAI_KEY }));
  }
  return serveStatic(req, res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Port ${PORT} bereits belegt — nutze laufenden Server.`);
  } else {
    console.error("Server-Fehler:", e);
  }
});

server.listen(PORT, () => {
  console.log(`Day One läuft auf http://localhost:${PORT}  (Modell: ${MODEL}, Key: ${OPENAI_KEY ? "gesetzt" : "FEHLT"})`);
});
