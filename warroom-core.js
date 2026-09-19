const LOCAL_PROXY = ''; // same-origin: works locally (this server serves the page too) and once hosted on Render

// Shared-secret support: when the server has RUKA_ACCESS_TOKEN set, every
// API route needs the matching X-Access-Token header. The token is asked
// for once (on the first 401), stored in localStorage, and attached to
// every request from then on — done here, in one place, by wrapping fetch
// itself so every call site gets it for free.
const _origFetch = window.fetch.bind(window);
let _tokenPrompted = false;
window.fetch = async (input, init = {}) => {
  const headers = Object.assign({}, init.headers || {});
  const token = localStorage.getItem('warroom_access_token');
  if(token && !headers['X-Access-Token']) headers['X-Access-Token'] = token;
  let res;
  try{
    res = await _origFetch(input, Object.assign({}, init, { headers }));
  }catch(err){ throw err; }
  if(res.status === 401 && !_tokenPrompted){
    _tokenPrompted = true;
    const entered = window.prompt('This server is locked. Enter the access token (the value of RUKA_ACCESS_TOKEN on the server):');
    if(entered != null && entered.trim()){
      localStorage.setItem('warroom_access_token', entered.trim());
      headers['X-Access-Token'] = entered.trim();
      return _origFetch(input, Object.assign({}, init, { headers }));
    }
  }
  return res;
};
const state = { clanTag:null, clan:null, war:null, warlog:null, capital:null, cwl:null, cwlHistory:[], warHistory:[], capitalHistory:[], notes:[], allNotes:[], notebook:'General', notebooks:['General'], thLevels:{}, currentConversationId:null, conversations:[], attackLog:[] };
let chatHistory = []; // running list of {role, content} for actual conversation memory
let memberSort = { key: 'rank', dir: 'asc' };
let thLoading = false;

const $ = sel => document.querySelector(sel);
const esc = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Expands CoC's compact "YYYYMMDDTHHMMSS.000Z" timestamp into a real ISO
// string; passes anything else through unchanged (already-ISO Supabase
// timestamps, etc.).
function toIsoTimestamp(value){
  if(!value) return null;
  if(/^\d{8}T/.test(value)){
    const y = value.slice(0,4), mo = value.slice(4,6), d = value.slice(6,8);
    const hh = value.slice(9,11) || '00', mi = value.slice(11,13) || '00', ss = value.slice(13,15) || '00';
    return `${y}-${mo}-${d}T${hh}:${mi}:${ss}Z`;
  }
  return value;
}

// Parses any timestamp shape down to epoch milliseconds. Used to dedupe the
// same war/raid across sources (live CoC data vs. Supabase-archived data)
// that may represent the identical instant as DIFFERENT strings — e.g. if a
// column is typed timestamptz, Postgres round-trips "20260913T182241.000Z"
// back as "2026-09-13T18:22:41+00:00". Those never string-match, but their
// epoch-ms values do, which is why merges below key on this instead of the
// raw string.
function toEpochMs(value){
  const iso = toIsoTimestamp(value);
  if(!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

// Formats any date-like value as DD/MM/YYYY, converted to India Standard
// Time (Asia/Kolkata, UTC+5:30) regardless of the machine's own timezone.
// Accepts normal ISO strings (Supabase's created_at/updated_at) as well as
// the CoC API's compact "YYYYMMDDTHHMMSS.000Z" timestamps (endTime/startTime)
// — the compact form is expanded into a real ISO string first so its time
// component is actually used in the conversion (skipping it would let dates
// near the UTC/IST day boundary come out a day off).
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
function formatDMY(value){
  const iso = toIsoTimestamp(value);
  if(!iso) return '—';
  const date = new Date(iso);
  if(isNaN(date)) return '—';
  return IST_DATE_FORMATTER.format(date); // en-GB renders as DD/MM/YYYY
}

// --- Phase 4: monthly rollups, so the archive stays cheap to include in
// context as it grows, instead of a fixed item-count cap that eventually
// stops covering "recent" at all (see improvement.md Problem 3). "Current
// month" is IST-based, matching this app's other date handling (see
// IST_DATE_FORMATTER above) rather than the server or browser's own
// timezone, so the boundary lines up with what the person actually sees as
// "this month" here.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function monthKey(value){
  const ms = toEpochMs(value);
  if(ms == null) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(key){
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function rollupWarsByMonth(wars){
  const byMonth = new Map();
  wars.forEach(w => {
    const key = monthKey(w.endTime);
    if(!key) return;
    if(!byMonth.has(key)) byMonth.set(key, { month: key, totalWars: 0, wins: 0, losses: 0, ties: 0, ourStarsSum: 0, theirStarsSum: 0 });
    const agg = byMonth.get(key);
    agg.totalWars++;
    if(w.result === 'win') agg.wins++;
    else if(w.result === 'lose') agg.losses++;
    else if(w.result === 'tie') agg.ties++;
    agg.ourStarsSum += w.ourStars || 0;
    agg.theirStarsSum += w.theirStars || 0;
  });
  return Array.from(byMonth.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabel(agg.month), totalWars: agg.totalWars,
      wins: agg.wins, losses: agg.losses, ties: agg.ties,
      avgOurStars: agg.totalWars ? +(agg.ourStarsSum / agg.totalWars).toFixed(2) : 0,
      avgTheirStars: agg.totalWars ? +(agg.theirStarsSum / agg.totalWars).toFixed(2) : 0
    }));
}

function rollupCapitalByMonth(raids){
  const byMonth = new Map();
  raids.forEach(r => {
    const key = monthKey(r.startTime);
    if(!key) return;
    if(!byMonth.has(key)) byMonth.set(key, { month: key, weekendCount: 0, totalLootSum: 0, raidsCompletedSum: 0, totalAttacksSum: 0 });
    const agg = byMonth.get(key);
    agg.weekendCount++;
    agg.totalLootSum += r.totalLoot || 0;
    agg.raidsCompletedSum += r.raidsCompleted || 0;
    agg.totalAttacksSum += r.totalAttacks || 0;
  });
  return Array.from(byMonth.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabel(agg.month), weekendCount: agg.weekendCount,
      totalLoot: agg.totalLootSum, totalRaidsCompleted: agg.raidsCompletedSum, totalAttacksUsed: agg.totalAttacksSum
    }));
}

// --- Panel collapse state, persisted locally so the layout stays how you left it ---
const PANEL_TITLES = {
  notesPanel: 'Notebook', warPanel: 'Current War', cwlPanel: 'Clan War League',
  membersPanel: 'Members', warlogPanel: 'War History', capitalPanel: 'Capital Raid Seasons',
  attackLogPanel: 'Attack Log',
  warHistoryFullPanel: 'War History (Full)', capitalHistoryFullPanel: 'Capital Raid History (Full)',
  cwlHistoryFullPanel: 'Clan War League History (Full)', settingsPanel: 'Settings'
};
let collapsedPanels = {};
try{ collapsedPanels = JSON.parse(localStorage.getItem('warroom_collapsed') || '{}'); }catch(e){ collapsedPanels = {}; }
function isPanelCollapsed(id){ return !!collapsedPanels[id]; }
function setPanelCollapsed(id, collapsed){
  collapsedPanels[id] = collapsed;
  try{ localStorage.setItem('warroom_collapsed', JSON.stringify(collapsedPanels)); }catch(e){}
}
function togglePanelCollapse(id){
  setPanelCollapsed(id, !isPanelCollapsed(id));
  renderAll();
}
// Builds a standard panel header with a Hide/Show toggle. Render functions
// pass their body HTML and get back the full panel innerHTML, already
// respecting the saved collapsed state.
function renderCollapsiblePanel(id, titleHtml, bodyHtml, extraHeaderBtnsHtml){
  const collapsed = isPanelCollapsed(id);
  return `
    <div class="panel-header-row">
      <h3><span class="dot"></span>${titleHtml}</h3>
      <div class="panel-header-btns">
        ${extraHeaderBtnsHtml || ''}
        <button class="btn-ghost btn-small collapse-toggle" data-panel="${id}">${collapsed ? 'Show' : 'Hide'}</button>
      </div>
    </div>
    <div class="panel-body" ${collapsed ? 'hidden' : ''}>${bodyHtml}</div>
  `;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.collapse-toggle');
  if(btn){ togglePanelCollapse(btn.dataset.panel); }
});
