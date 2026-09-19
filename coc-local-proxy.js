// Riuka — Clan War Room server.
// Local dev:  node coc-local-proxy.js   (reads .env)
// On Render:  set env vars in the service's Environment tab — no .env there.
//
// Serves the dashboard page, forwards API calls to Clash of Clans (via the
// RoyaleAPI proxy), Sarvam and Gemini — all using this server's credentials,
// so none of them ever reach the browser — and reads/writes the Riuka
// Supabase schema through lib/.
//
// New in the Riuka upgrade:
//   * POST /ask        — full chat pipeline: deterministic engine + scoped
//                        context + tool calling + Sarvam↔Gemini fallback
//                        (see lib/chatEngine.js)
//   * GET  /answer     — full long answers ("See more"), 30-day retention
//   * GET  /sync-status— recent sync_runs rows (poller observability)
//   * RUKA_ACCESS_TOKEN — optional shared secret for every API route
//   * ALLOWED_ORIGIN   — optional CORS lockdown to a single origin
//   * The background poller now runs the full sync suite (clan/roster
//     snapshots, war, warlog, capital, CWL) and logs every run to sync_runs.

require('dotenv').config();

const COC_TOKEN = process.env.COC_TOKEN;
const SARVAM_TOKEN = process.env.SARVAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ACCESS_TOKEN = process.env.RUKA_ACCESS_TOKEN || null;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { getCwlHistory, saveCwlSeason } = require('./lib/cwlHistory');
const { getWarHistory, saveWar } = require('./lib/warHistory');
const { getCapitalHistory, saveCapitalSeason } = require('./lib/capitalHistory');
const { getNotes, addNote, deleteNote, searchNotes, listNotebooks } = require('./lib/notes');
const { listConversations, createConversation, deleteConversation, getMessages } = require('./lib/chatHistory');
const { getAttackLog, saveAttacks } = require('./lib/attackLog');
const { callGemini } = require('./lib/geminiProxy');
const { answerQuestion, getFullAnswer } = require('./lib/chatEngine');
const { getSyncStatus } = require('./lib/retrieval');
const sync = require('./lib/sync');

const PORT = process.env.PORT || 8787;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCors(res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        payload.length ? { 'Content-Length': payload.length } : {},
        extraHeaders
      ),
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    if (payload.length) proxyReq.write(payload);
    proxyReq.end();
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch (e) {
    return null;
  }
}

// Shared-secret gate: when RUKA_ACCESS_TOKEN is set, every API route (except
// serving the page itself) requires the browser to send the matching
// X-Access-Token header. war-room.html asks for it once and stores it in
// localStorage.
function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const header = req.headers['x-access-token'];
  return header === ACCESS_TOKEN;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // The dashboard page itself is always served; the token gate applies to
  // the API routes below (the page needs to load to ask for the token).
  if (req.method === 'GET' && (req.url === '/' || req.url === '/war-room.html')) {
    const filePath = path.join(__dirname, 'war-room.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end("war-room.html not found - make sure it's in the same folder as this script.");
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized — a valid X-Access-Token header is required.' });
    return;
  }

  if (req.url.startsWith('/coc/')) {
    if (!COC_TOKEN) { sendJson(res, 500, { error: 'COC_TOKEN is not set on the server.' }); return; }
    const cocPath = '/v1' + req.url.replace('/coc', '');
    forward(
      req, res,
      'cocproxy.royaleapi.dev',
      cocPath,
      { Authorization: `Bearer ${COC_TOKEN}` },
      'GET'
    );
    return;
  }

  if (req.url === '/sarvam/chat') {
    if (!SARVAM_TOKEN) { sendJson(res, 500, { error: 'SARVAM_TOKEN is not set on the server.' }); return; }
    forward(
      req, res,
      'api.sarvam.ai',
      '/v1/chat/completions',
      { Authorization: `Bearer ${SARVAM_TOKEN}` },
      'POST'
    );
    return;
  }

  // Gemini's request/response shape is nothing like Sarvam's OpenAI-compatible
  // one, so this route parses the body and translates both ways — that's what
  // lib/geminiProxy.js's callGemini() does.
  if (req.url === '/gemini/chat') {
    if (!GEMINI_API_KEY) { sendJson(res, 500, { error: 'GEMINI_API_KEY is not set on the server.' }); return; }
    try {
      const body = await readJsonBody(req);
      if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
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

  // --- The chat pipeline -------------------------------------------------
  // POST /ask { clanTag, question, conversationId?, provider? }
  //   -> { answer, conversation_id, answer_id?, full_answer_truncated, provider }
  if (req.url === '/ask') {
    try {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      const body = await readJsonBody(req);
      if (!body || !body.clanTag || !body.question) {
        sendJson(res, 400, { error: 'clanTag and question are required' });
        return;
      }
      const result = await answerQuestion({
        clanTag: body.clanTag,
        question: body.question,
        conversationId: body.conversationId || null,
        provider: body.provider || (process.env.AI_PROVIDER || 'sarvam'),
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.failures ? 502 : 500, { error: err.message, failures: err.failures });
    }
    return;
  }

  // GET /answer?id=<uuid> -> the full stored long answer ("See more")
  if (req.url.startsWith('/answer')) {
    try {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const id = url.searchParams.get('id');
      if (!id) { sendJson(res, 400, { error: 'id query param required' }); return; }
      const data = await getFullAnswer(id);
      if (!data) { sendJson(res, 404, { error: 'Answer not found' }); return; }
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /sync-status?limit=20 -> recent sync runs (poller observability)
  if (req.url.startsWith('/sync-status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const runs = await getSyncStatus({ limit });
      sendJson(res, 200, { runs });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // POST /sync/now -> run one full sync tick immediately (manual refresh)
  if (req.url === '/sync/now') {
    try {
      const clanTag = (await readJsonBody(req)).clanTag || CLAN_TAG;
      if (!clanTag) { sendJson(res, 400, { error: 'clanTag required (or set CLAN_TAG on the server)' }); return; }
      const live = await sync.fullSyncTick(clanTag);
      sendJson(res, 200, { ok: true, live });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- CWL season history -------------------------------------------------
  if (req.url.startsWith('/cwl-history')) {
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get('clanTag');
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const history = await getCwlHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, season, rounds } = body;
        if (!clanTag || !season || !rounds) { sendJson(res, 400, { error: 'clanTag, season, and rounds are all required' }); return; }
        const saved = await saveCwlSeason(clanTag, season, rounds);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Regular war history --------------------------------------------------
  if (req.url.startsWith('/war-history')) {
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get('clanTag');
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const history = await getWarHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, ...war } = body;
        if (!clanTag || !war.endTime) { sendJson(res, 400, { error: 'clanTag and endTime are required' }); return; }
        const saved = await saveWar(clanTag, war);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Capital raid history -------------------------------------------------
  if (req.url.startsWith('/capital-history')) {
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clanTag = url.searchParams.get('clanTag');
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const history = await getCapitalHistory(clanTag);
        sendJson(res, 200, { history });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, ...season } = body;
        if (!clanTag || !season.startTime) { sendJson(res, 400, { error: 'clanTag and startTime are required' }); return; }
        const saved = await saveCapitalSeason(clanTag, season);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Notebook -------------------------------------------------------------
  if (req.url.startsWith('/notes') && !req.url.startsWith('/notebooks')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        const clanTag = url.searchParams.get('clanTag');
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const notebook = url.searchParams.get('notebook') || undefined;
        const q = url.searchParams.get('q');
        const notes = q ? await searchNotes(clanTag, q, notebook) : await getNotes(clanTag, notebook);
        sendJson(res, 200, { notes });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, content, notebook } = body;
        if (!clanTag || !content || !content.trim()) { sendJson(res, 400, { error: 'clanTag and non-empty content are required' }); return; }
        const saved = await addNote(clanTag, content.trim(), notebook);
        sendJson(res, 200, { saved: true, data: saved });
        return;
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) { sendJson(res, 400, { error: 'id query param required' }); return; }
        await deleteNote(id);
        sendJson(res, 200, { deleted: true });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.url.startsWith('/notebooks')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const clanTag = url.searchParams.get('clanTag');
      if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
      const notebooks = await listNotebooks(clanTag);
      sendJson(res, 200, { notebooks });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Chat history ---------------------------------------------------------
  if (req.url.startsWith('/chats') && !req.url.startsWith('/chat-messages')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        const clanTag = url.searchParams.get('clanTag');
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const conversations = await listConversations(clanTag);
        sendJson(res, 200, { conversations });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, title } = body;
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag is required' }); return; }
        const conversation = await createConversation(clanTag, title || 'New chat');
        sendJson(res, 200, { conversation });
        return;
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) { sendJson(res, 400, { error: 'id query param required' }); return; }
        await deleteConversation(id);
        sendJson(res, 200, { deleted: true });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.url.startsWith('/chat-messages')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        const conversationId = url.searchParams.get('conversationId');
        if (!conversationId) { sendJson(res, 400, { error: 'conversationId query param required' }); return; }
        const messages = await getMessages(conversationId);
        sendJson(res, 200, { messages });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed — /ask persists messages itself' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // --- Attack log -----------------------------------------------------------
  if (req.url.startsWith('/attack-log')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        const clanTag = url.searchParams.get('clanTag');
        const context = url.searchParams.get('context') || undefined;
        const contextRef = url.searchParams.get('contextRef') || undefined;
        const attackerContains = url.searchParams.get('attackerContains') || undefined;
        const defenderContains = url.searchParams.get('defenderContains') || undefined;
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
        if (!clanTag) { sendJson(res, 400, { error: 'clanTag query param required' }); return; }
        const log = await getAttackLog(clanTag, { context, contextRef, attackerContains, defenderContains, limit });
        sendJson(res, 200, { log });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
        const { clanTag, attacks } = body;
        if (!clanTag || !Array.isArray(attacks)) { sendJson(res, 400, { error: 'clanTag and attacks[] (array) are required' }); return; }
        const saved = await saveAttacks(clanTag, attacks);
        sendJson(res, 200, { saved: true, count: saved ? (saved.war + saved.capital + saved.cwl) : 0, detail: saved });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown route' }));
});

// ---------------------------------------------------------------------------
// Background polling — the full sync suite, running on a timer with the same
// lib/sync.js jobs /ask and the routes use. Every job logs to sync_runs, so
// a failing CoC proxy or Supabase is visible on /sync-status instead of
// silently staling the dashboard.
// ---------------------------------------------------------------------------

let CLAN_TAG = process.env.CLAN_TAG || null;
if (CLAN_TAG) {
  CLAN_TAG = CLAN_TAG.trim().toUpperCase();
  if (!CLAN_TAG.startsWith('#')) CLAN_TAG = '#' + CLAN_TAG;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
const BG_LIVE_POLL_MS = clamp(parseInt(process.env.BG_POLL_INTERVAL_MS, 10) || 30000, 10000, 600000);
const BG_IDLE_POLL_MS = 5 * 60 * 1000;

let pollBusy = false;
async function backgroundPollTick() {
  if (pollBusy) return false; // never overlap syncs (single-writer rule)
  pollBusy = true;
  let live = false;
  try {
    live = await sync.fullSyncTick(CLAN_TAG);
    console.log(`[bg-poll] tick complete — live=${live}.`);
  } catch (err) {
    console.warn('[bg-poll] tick failed:', err.message);
  } finally {
    pollBusy = false;
  }
  return live;
}

function scheduleNextBackgroundPoll() {
  backgroundPollTick().then((live) => {
    const delay = live ? BG_LIVE_POLL_MS : BG_IDLE_POLL_MS;
    setTimeout(() => scheduleNextBackgroundPoll(), delay);
  });
}

function startBackgroundPolling() {
  if (!CLAN_TAG) {
    console.log('[bg-poll] CLAN_TAG env var not set — background polling is OFF. The dashboard still works, but history is only recorded by an open browser tab.');
    return;
  }
  if (!COC_TOKEN) {
    console.log("[bg-poll] COC_TOKEN not set - cannot start background polling without it.");
    return;
  }
  console.log(`[bg-poll] Starting for ${CLAN_TAG} — live checks every ${BG_LIVE_POLL_MS / 1000}s, idle checks every ${BG_IDLE_POLL_MS / 60000}min.`);
  scheduleNextBackgroundPoll();
}

server.listen(PORT, () => {
  if (!COC_TOKEN || !SARVAM_TOKEN) {
    console.log('\nWARNING: COC_TOKEN and/or SARVAM_TOKEN are missing - set them in your .env file (local) or your host environment variables (Render).\n');
  }
  if (!GEMINI_API_KEY) {
    console.log("INFO: GEMINI_API_KEY is not set - /ask will use Sarvam only until it's added.\n");
  }
  if (ACCESS_TOKEN) {
    console.log('LOCKED: RUKA_ACCESS_TOKEN is set - all API routes require the X-Access-Token header.\n');
  }
  startBackgroundPolling();
});
