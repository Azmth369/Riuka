// Server for the Clan War Room dashboard.
// Local dev:  node coc-local-proxy.js   (reads .env)
// On Render:  set env vars in the service's Environment tab — no .env file needed there.
//
// Serves the dashboard page, forwards its API calls to Clash of Clans
// (via the RoyaleAPI proxy) and Sarvam AI, and now also reads/writes CWL
// season history in Supabase — all using this server's credentials, so
// none of them are ever sent to the browser.

require('dotenv').config();

const COC_TOKEN = process.env.COC_TOKEN;
const SARVAM_TOKEN = process.env.SARVAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { getCwlHistory, saveCwlSeason } = require("./lib/cwlHistory");
const { getWarHistory, saveWar } = require("./lib/warHistory");
const { getCapitalHistory, saveCapitalSeason } = require("./lib/capitalHistory");
const { getNotes, addNote, deleteNote, searchNotes, listNotebooks } = require("./lib/notes");
const { listConversations, createConversation, deleteConversation, getMessages, addMessage } = require("./lib/chatHistory");
const { getAttackLog, saveAttacks } = require("./lib/attackLog");
const { callGemini } = require("./lib/geminiProxy");

const PORT = process.env.PORT || 8787;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forward(req, res, hostname, forwardPath, extraHeaders, method) {
  readBody(req).then((payload) => {
    const options = {
      hostname,
      path: forwardPath,
      method: method || req.method,
      headers: Object.assign(
        {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        payload.length ? { "Content-Length": payload.length } : {},
        extraHeaders
      ),
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });

    if (payload.length) proxyReq.write(payload);
    proxyReq.end();
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/war-room.html")) {
    const filePath = path.join(__dirname, "war-room.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("war-room.html not found — make sure it's in the same folder as this script.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  if (req.url.startsWith("/coc/")) {
    if (!COC_TOKEN) { sendJson(res, 500, { error: "COC_TOKEN is not set on the server." }); return; }
    const cocPath = "/v1" + req.url.replace("/coc", "");
    forward(
      req,
      res,
      "cocproxy.royaleapi.dev",
      cocPath,
      { Authorization: `Bearer ${COC_TOKEN}` },
      "GET"
    );
    return;
  }

  if (req.url === "/sarvam/chat") {
    if (!SARVAM_TOKEN) { sendJson(res, 500, { error: "SARVAM_TOKEN is not set on the server." }); return; }
    forward(
      req,
      res,
      "api.sarvam.ai",
      "/v1/chat/completions",
      { Authorization: `Bearer ${SARVAM_TOKEN}` },
      "POST"
    );
    return;
  }

  // Gemini's request/response shape is nothing like Sarvam's OpenAI-compatible
  // one, so unlike /sarvam/chat above (a byte-for-byte pass-through proxy),
  // this route actually has to parse the body and translate both ways —
  // that's what lib/geminiProxy.js's callGemini() does. war-room.html sends
  // the exact same { messages, temperature, max_tokens, tools } shape either
  // way, and gets the exact same { choices: [...] } shape back either way.
  if (req.url === "/gemini/chat") {
    if (!GEMINI_API_KEY) { sendJson(res, 500, { error: "GEMINI_API_KEY is not set on the server." }); return; }
    try {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString("utf8") || "{}"); }
      catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
      const result = await callGemini(GEMINI_API_KEY, {
        messages: body.messages,
        temperature: body.temperature,
        maxOutputTokens: body.max_tokens,
        tools: body.tools,
        model: body.model,
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  // --- CWL season history, backed by Supabase ---
  // GET  /cwl-history?clanTag=%23ABC123      -> [{ season, rounds, saved_at }, ...]
  // POST /cwl-history  { clanTag, season, rounds }  -> upserts one season
  if (req.url.startsWith("/cwl-history")) {
    try {
      if (req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get("clanTag");
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const history = await getCwlHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, season, rounds } = body;
        if (!clanTag || !season || !rounds) {
          sendJson(res, 400, { error: "clanTag, season, and rounds are all required" });
          return;
        }
        const saved = await saveCwlSeason(clanTag, season, rounds);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Regular war history, backed by Supabase ---
  // GET  /war-history?clanTag=%23ABC123     -> [{ end_time, opponent_name, result, ... }, ...]
  // POST /war-history { clanTag, endTime, opponentName, teamSize, result, ourStars, theirStars, ourDestruction, theirDestruction } -> upserts one war
  if (req.url.startsWith("/war-history")) {
    try {
      if (req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get("clanTag");
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const history = await getWarHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, ...war } = body;
        if (!clanTag || !war.endTime) { sendJson(res, 400, { error: "clanTag and endTime are required" }); return; }
        const saved = await saveWar(clanTag, war);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Capital raid history, backed by Supabase ---
  // GET  /capital-history?clanTag=%23ABC123  -> [{ start_time, total_loot, members, ... }, ...]
  // POST /capital-history { clanTag, startTime, totalLoot, raidsCompleted, totalAttacks, members } -> upserts one weekend
  if (req.url.startsWith("/capital-history")) {
    try {
      if (req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get("clanTag");
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const history = await getCapitalHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, ...season } = body;
        if (!clanTag || !season.startTime) { sendJson(res, 400, { error: "clanTag and startTime are required" }); return; }
        const saved = await saveCapitalSeason(clanTag, season);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Notebook, backed by Supabase ---
  // GET    /notes?clanTag=%23ABC123[&notebook=General][&q=keyword]
  //          -> [{ id, content, created_at, notebook }, ...]
  //          notebook filters to one notebook; q runs a real Postgres
  //          full-text search instead of a plain listing (see lib/notes.js
  //          and notes-migration.sql for the search index this needs).
  // POST   /notes { clanTag, content, notebook? }  -> adds one note (defaults to 'General')
  // DELETE /notes?id=123                           -> removes one note
  if (req.url.startsWith("/notes") && !req.url.startsWith("/notebooks")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET") {
        const clanTag = url.searchParams.get("clanTag");
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const notebook = url.searchParams.get("notebook") || undefined;
        const q = url.searchParams.get("q");
        const notes = q ? await searchNotes(clanTag, q, notebook) : await getNotes(clanTag, notebook);
        sendJson(res, 200, { notes });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, content, notebook } = body;
        if (!clanTag || !content || !content.trim()) { sendJson(res, 400, { error: "clanTag and non-empty content are required" }); return; }
        const saved = await addNote(clanTag, content.trim(), notebook);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) { sendJson(res, 400, { error: "id query param required" }); return; }
        await deleteNote(id);
        sendJson(res, 200, { deleted: true });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /notebooks?clanTag=%23ABC123 -> ["General", "War Planning", ...]
  // Distinct notebook names in use for this clan, for populating a picker —
  // 'General' is always included even before any note exists.
  if (req.url.startsWith("/notebooks")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const clanTag = url.searchParams.get("clanTag");
      if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
      const notebooks = await listNotebooks(clanTag);
      sendJson(res, 200, { notebooks });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Chat history, backed by Supabase ---
  // GET    /chats?clanTag=%23ABC123        -> [{ id, title, updated_at }, ...]
  // POST   /chats { clanTag, title }        -> creates a conversation, returns it
  // DELETE /chats?id=123                    -> deletes a conversation and its messages
  if (req.url.startsWith("/chats") && !req.url.startsWith("/chat-messages")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET") {
        const clanTag = url.searchParams.get("clanTag");
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const conversations = await listConversations(clanTag);
        sendJson(res, 200, { conversations });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, title } = body;
        if (!clanTag) { sendJson(res, 400, { error: "clanTag is required" }); return; }
        const conversation = await createConversation(clanTag, title || "New chat");
        sendJson(res, 200, { conversation });
        return;
      }
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) { sendJson(res, 400, { error: "id query param required" }); return; }
        await deleteConversation(id);
        sendJson(res, 200, { deleted: true });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET  /chat-messages?conversationId=123              -> [{ role, content, created_at }, ...]
  // POST /chat-messages { conversationId, role, content } -> appends one message
  if (req.url.startsWith("/chat-messages")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) { sendJson(res, 400, { error: "conversationId query param required" }); return; }
        const messages = await getMessages(conversationId);
        sendJson(res, 200, { messages });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { conversationId, role, content } = body;
        if (!conversationId || !role || !content) { sendJson(res, 400, { error: "conversationId, role, and content are required" }); return; }
        await addMessage(conversationId, role, content);
        sendJson(res, 200, { saved: true });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Attack log (individual attacks during war/CWL/capital raids), backed by Supabase ---
  // GET  /attack-log?clanTag=%23ABC123&context=war&contextRef=...   -> [{...}, ...]
  //   (context and contextRef are both optional filters)
  // POST /attack-log { clanTag, attacks: [...] }  -> upserts many at once, silently
  //   skipping any that were already saved (see lib/attackLog.js for the dedupe key)
  if (req.url.startsWith("/attack-log")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET") {
        const clanTag = url.searchParams.get("clanTag");
        const context = url.searchParams.get("context") || undefined;
        const contextRef = url.searchParams.get("contextRef") || undefined;
        if (!clanTag) { sendJson(res, 400, { error: "clanTag query param required" }); return; }
        const log = await getAttackLog(clanTag, context, contextRef);
        sendJson(res, 200, { log });
        return;
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); }
        catch (e) { sendJson(res, 400, { error: "Invalid JSON body" }); return; }
        const { clanTag, attacks } = body;
        if (!clanTag || !Array.isArray(attacks)) { sendJson(res, 400, { error: "clanTag and attacks[] (array) are required" }); return; }
        const saved = await saveAttacks(clanTag, attacks);
        sendJson(res, 200, { saved: true, count: saved ? saved.length : 0 });
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown route" }));
});

// ============================================================================
// Background polling — keeps war/CWL/capital history and the attack log
// updating even when nobody has the dashboard open in a browser. Runs
// entirely inside this Node process on a timer, using the same lib/*.js
// save functions the HTTP routes above use, and its own direct calls to the
// CoC proxy (the browser's cocFetch() has no equivalent here since there's
// no browser). Only runs at all if CLAN_TAG is set in the environment —
// without it, the dashboard still works exactly as before, just without an
// unattended background recorder for any particular clan.
let CLAN_TAG = process.env.CLAN_TAG || null;
if (CLAN_TAG) {
  CLAN_TAG = CLAN_TAG.trim().toUpperCase();
  if (!CLAN_TAG.startsWith("#")) CLAN_TAG = "#" + CLAN_TAG;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
const BG_LIVE_POLL_MS = clamp(parseInt(process.env.BG_POLL_INTERVAL_MS, 10) || 30000, 10000, 600000);
const BG_IDLE_POLL_MS = 5 * 60 * 1000; // when nothing's live, just check occasionally for something starting

async function cocGet(path) {
  const res = await fetch(`https://cocproxy.royaleapi.dev/v1${path}`, {
    headers: { Authorization: `Bearer ${COC_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

function computeWarResult(us, opponent) {
  if (us.stars !== opponent.stars) return us.stars > opponent.stars ? "win" : "lose";
  if (us.destructionPercentage !== opponent.destructionPercentage) return us.destructionPercentage > opponent.destructionPercentage ? "win" : "lose";
  return "tie";
}
function isRegularWarEntry(item) { return !!(item.opponent && item.opponent.name); }
function mapCapitalMembersForBg(rawMembers) {
  return (rawMembers || []).map((m) => ({
    tag: m.tag, name: m.name, attacksUsed: m.attacks,
    attackLimit: (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    loot: m.capitalResourcesLooted,
  }));
}
function buildTagNameLookup(members) {
  const map = new Map();
  (members || []).forEach((m) => { if (m && m.tag) map.set(m.tag, m.name); });
  return map;
}
// Same extraction logic as the browser's extractWarAttacks()/extractCapitalAttacks() —
// kept in sync by hand since this file has no build step to share code with war-room.html.
function extractWarAttacks(w, context, contextRef) {
  if (!w || !w.clan || !w.opponent || !contextRef) return [];
  const ourNames = buildTagNameLookup(w.clan.members);
  const theirNames = buildTagNameLookup(w.opponent.members);
  const out = [];
  (w.clan.members || []).forEach((m) => {
    (m.attacks || []).forEach((a) => {
      out.push({ context, contextRef, attackerTag: m.tag, attackerName: m.name,
        defenderTag: a.defenderTag, defenderName: theirNames.get(a.defenderTag) || null,
        stars: a.stars, destructionPercent: a.destructionPercentage, attackOrder: a.order });
    });
  });
  (w.opponent.members || []).forEach((m) => {
    (m.attacks || []).forEach((a) => {
      out.push({ context, contextRef, attackerTag: m.tag, attackerName: m.name,
        defenderTag: a.defenderTag, defenderName: ourNames.get(a.defenderTag) || null,
        stars: a.stars, destructionPercent: a.destructionPercentage, attackOrder: a.order });
    });
  });
  return out;
}
function extractCapitalAttacks(raidItem, contextRef) {
  if (!raidItem || !contextRef) return [];
  const out = [];
  (raidItem.attackLog || []).forEach((enemy) => {
    (enemy.districts || []).forEach((d) => {
      (d.attacks || []).forEach((a, idx) => {
        out.push({
          context: "capital", contextRef,
          attackerTag: a.attacker?.tag, attackerName: a.attacker?.name,
          defenderTag: `${enemy.defender?.tag || "enemy"}:${d.id}`,
          defenderName: `${enemy.defender?.name || "Enemy capital"} — ${d.name}`,
          stars: a.stars, destructionPercent: a.destructionPercent, attackOrder: idx,
        });
      });
    });
  });
  return out;
}
function parseCoCTimeToMs(value) {
  if (!value || !/^\d{8}T/.test(value)) return NaN;
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`;
  return new Date(iso).getTime();
}
function isCapitalRaidLive(raid) {
  if (!raid || !raid.startTime || !raid.endTime) return false;
  const now = Date.now();
  const start = parseCoCTimeToMs(raid.startTime);
  const end = parseCoCTimeToMs(raid.endTime);
  if (isNaN(start) || isNaN(end)) return false;
  return now >= start && now <= end;
}

async function loadCwlLeagueForBg(clanTag) {
  const tagPath = encodeURIComponent(clanTag);
  let group;
  try { group = await cocGet(`/clans/${tagPath}/currentwar/leaguegroup`); }
  catch (e) { return null; } // not in CWL right now — normal, not an error
  if (!group || !group.rounds) return null;

  const rounds = [];
  for (let i = 0; i < group.rounds.length; i++) {
    const tags = (group.rounds[i].warTags || []).filter((t) => t && t !== "#0");
    if (tags.length === 0) continue;
    const wars = await Promise.all(tags.map((t) => cocGet(`/clanwarleagues/wars/${encodeURIComponent(t)}`).catch(() => null)));
    const ourWar = wars.find((w) => w && (w.clan?.tag === clanTag || w.opponent?.tag === clanTag));
    if (!ourWar) continue;
    rounds.push({ round: i + 1, state: ourWar.state, rawWar: ourWar });
  }
  return { season: group.season, rounds };
}

// One full pass: fetch current war/CWL/capital state, save history + attacks,
// and report back whether anything is live right now (so the caller can pick
// the next check's delay). Every save is best-effort — one failure (e.g. a
// transient Supabase hiccup) doesn't stop the others in the same tick.
async function backgroundPollTick(clanTag) {
  let live = false;
  const tagPath = encodeURIComponent(clanTag);
  const attackBatch = [];

  try {
    let war = null;
    try { war = await cocGet(`/clans/${tagPath}/currentwar`); } catch (e) { war = null; }
    if (war && war.state === "inWar") live = true;
    if (war && war.state === "warEnded" && war.endTime) {
      await saveWar(clanTag, {
        endTime: war.endTime, opponentName: war.opponent.name, teamSize: war.teamSize,
        result: computeWarResult(war.clan, war.opponent), ourStars: war.clan.stars, theirStars: war.opponent.stars,
        ourDestruction: war.clan.destructionPercentage, theirDestruction: war.opponent.destructionPercentage,
      }).catch((e) => console.warn("[bg-poll] saveWar error:", e.message));
    }
    if (war && war.endTime) attackBatch.push(...extractWarAttacks(war, "war", war.endTime));

    try {
      const clan = await cocGet(`/clans/${tagPath}`);
      if (clan.isWarLogPublic) {
        const warlog = await cocGet(`/clans/${tagPath}/warlog?limit=10`);
        for (const item of warlog.items || []) {
          if (!item.endTime || !isRegularWarEntry(item)) continue;
          await saveWar(clanTag, {
            endTime: item.endTime, opponentName: item.opponent?.name, teamSize: item.teamSize,
            result: item.result, ourStars: item.clan.stars, theirStars: item.opponent.stars,
            ourDestruction: item.clan.destructionPercentage, theirDestruction: item.opponent.destructionPercentage,
          }).catch((e) => console.warn("[bg-poll] warlog saveWar error:", e.message));
        }
      }
    } catch (e) { /* war log private/unavailable — not an error */ }

    try {
      const capital = await cocGet(`/clans/${tagPath}/capitalraidseasons?limit=3`);
      for (const s of capital.items || []) {
        if (!s.startTime) continue;
        await saveCapitalSeason(clanTag, {
          startTime: s.startTime, totalLoot: s.capitalTotalLoot, raidsCompleted: s.raidsCompleted,
          totalAttacks: s.totalAttacks, members: mapCapitalMembersForBg(s.members),
        }).catch((e) => console.warn("[bg-poll] saveCapitalSeason error:", e.message));
      }
      const latest = capital.items?.[0];
      if (latest && isCapitalRaidLive(latest)) live = true;
      if (latest && latest.startTime) attackBatch.push(...extractCapitalAttacks(latest, latest.startTime));
    } catch (e) { /* no capital data right now — not an error */ }

    try {
      const cwl = await loadCwlLeagueForBg(clanTag);
      if (cwl && cwl.season && cwl.rounds.length) {
        if (cwl.rounds.some((r) => r.state === "inWar")) live = true;
        await saveCwlSeason(clanTag, cwl.season, cwl.rounds.map(({ rawWar, ...r }) => r))
          .catch((e) => console.warn("[bg-poll] saveCwlSeason error:", e.message));
        cwl.rounds.forEach((r) => {
          if (r.rawWar) attackBatch.push(...extractWarAttacks(r.rawWar, "cwl", `${cwl.season}:R${r.round}`));
        });
      }
    } catch (e) { /* not in CWL right now — not an error */ }

    if (attackBatch.length) {
      await saveAttacks(clanTag, attackBatch).catch((e) => console.warn("[bg-poll] saveAttacks error:", e.message));
    }
    console.log(`[bg-poll] tick complete — ${attackBatch.length} attacks checked, live=${live}.`);
  } catch (err) {
    console.warn("[bg-poll] tick failed:", err.message);
  }
  return live;
}

function scheduleNextBackgroundPoll(clanTag) {
  backgroundPollTick(clanTag).then((live) => {
    const delay = live ? BG_LIVE_POLL_MS : BG_IDLE_POLL_MS;
    setTimeout(() => scheduleNextBackgroundPoll(clanTag), delay);
  });
}

function startBackgroundPolling() {
  if (!CLAN_TAG) {
    console.log("[bg-poll] CLAN_TAG env var not set — background polling is OFF. The dashboard still works normally, it just won't record data unless a browser tab has it open.");
    return;
  }
  if (!COC_TOKEN) {
    console.log("[bg-poll] COC_TOKEN not set — can't start background polling without it.");
    return;
  }
  console.log(`[bg-poll] Starting for ${CLAN_TAG} — live checks every ${BG_LIVE_POLL_MS / 1000}s, idle checks every ${BG_IDLE_POLL_MS / 60000}min.`);
  scheduleNextBackgroundPoll(CLAN_TAG);
}

server.listen(PORT, () => {
  console.log(`Clan War Room server listening on port ${PORT}`);
  if (!COC_TOKEN || !SARVAM_TOKEN) {
    console.log("\n⚠️  COC_TOKEN and/or SARVAM_TOKEN are missing — set them in your .env file (local) or your host's environment variables (Render).\n");
  }
  if (!GEMINI_API_KEY) {
    console.log("ℹ️  GEMINI_API_KEY is not set — the Gemini option in the dashboard's provider switch will return a 500 until it's added to your .env (or Render env vars).\n");
  }
  startBackgroundPolling();
});
