
const LOCAL_PROXY = ''; // same-origin: works locally (this server serves the page too) and once hosted on Render

// Shared-secret support: when the server has RUKA_ACCESS_TOKEN set, every API
// route needs an X-Access-Token header. The token is asked for once, kept in
// localStorage, and attached to every request here in one place.
const _origFetch = window.fetch.bind(window);
let _tokenPrompted = false;
window.fetch = async (input, init = {}) => {
  const token = localStorage.getItem('riuka_access_token');
  const headerObj = Object.assign({}, init.headers || {});
  if(token && !headerObj['X-Access-Token']) headerObj['X-Access-Token'] = token;
  let res;
  try{
    res = await _origFetch(input, Object.assign({}, init, { headers: headerObj }));
  }catch(err){ throw err; }
  if(res.status === 401 && !_tokenPrompted){
    _tokenPrompted = true;
    const t = prompt('This server requires an access token. Enter it to continue:');
    if(t){
      localStorage.setItem('riuka_access_token', t);
      headerObj['X-Access-Token'] = t;
      return _origFetch(input, Object.assign({}, init, { headers: headerObj }));
    }
  }
  return res;
};
const state = { clanTag:null, clan:null, war:null, warlog:null, capital:null, cwl:null, cwlHistory:[], warHistory:[], capitalHistory:[], notes:[], allNotes:[], notebook:'General', notebooks:['General'], thLevels:{}, currentConversationId:null, conversations:[], attackLog:[] };
let chatHistory = []; // running list of {role, content} for actual conversation memory
let memberSort = { key: 'rank', dir: 'asc' };
let thLoading = false;

const $ = sel => document.querySelector(sel);
const esc = s => (s ?? '').toString().replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));

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
$('#collapseAllBtn').addEventListener('click', () => {
  const anyExpanded = Object.keys(PANEL_TITLES).some(id => !isPanelCollapsed(id));
  Object.keys(PANEL_TITLES).forEach(id => setPanelCollapsed(id, anyExpanded));
  renderAll();
});

// --- Row-limiting for long tables ("show less"), persisted locally ---
let expandedTables = {};
try{ expandedTables = JSON.parse(localStorage.getItem('warroom_expanded_tables') || '{}'); }catch(e){ expandedTables = {}; }
function isTableExpanded(id){ return !!expandedTables[id]; }
function toggleTableExpanded(id){
  expandedTables[id] = !expandedTables[id];
  try{ localStorage.setItem('warroom_expanded_tables', JSON.stringify(expandedTables)); }catch(e){}
  renderAll();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.table-expand-toggle');
  if(btn){ toggleTableExpanded(btn.dataset.table); }
});
// rows: array of already-built <tr> html strings. Returns { rowsHtml, moreHtml }.
function limitRows(id, rows, defaultLimit){
  const expanded = isTableExpanded(id);
  const shown = expanded ? rows : rows.slice(0, defaultLimit);
  let moreHtml = '';
  if(rows.length > defaultLimit){
    moreHtml = `<div class="table-more-row"><button class="btn-ghost btn-small table-expand-toggle" data-table="${id}">${expanded ? 'Show less' : `Show all ${rows.length}`}</button></div>`;
  }
  return { rowsHtml: shown.join(''), moreHtml };
}

// --- Setup ("Connect your clan") panel collapse, same pattern as panel collapse above ---
let setupCollapsed = localStorage.getItem('warroom_setup_collapsed') === '1';
function applySetupCollapsed(){
  $('#setupBody').hidden = setupCollapsed;
  $('#setupPanel').classList.toggle('is-collapsed', setupCollapsed);
  $('#setupToggleBtn').textContent = setupCollapsed ? 'Show' : 'Hide';
}
function setSetupCollapsed(collapsed){
  setupCollapsed = collapsed;
  try{ localStorage.setItem('warroom_setup_collapsed', collapsed ? '1' : '0'); }catch(e){}
  applySetupCollapsed();
}
$('#setupToggleBtn').addEventListener('click', () => setSetupCollapsed(!setupCollapsed));
applySetupCollapsed();

// --- Settings: theme, table density, and section order — all local prefs, same pattern as above ---
const SECTION_LABELS = {
  secSummary: 'Clan Summary Details', secWar: 'Ongoing War Result', secInfo: 'Clan Info',
  secCapital: 'Ongoing Capital Raid', secAttackLog: 'Live Attack Log', secHistory: 'Full History', secNotes: 'Notes'
};
const DEFAULT_SECTION_ORDER = ['secSummary', 'secWar', 'secInfo', 'secCapital', 'secAttackLog', 'secHistory', 'secNotes'];
let sectionOrder = DEFAULT_SECTION_ORDER.slice();
try{
  const saved = JSON.parse(localStorage.getItem('warroom_section_order') || 'null');
  // Only trust a saved order if it's the same set of sections this version knows about —
  // guards against a stale order from an older file version breaking the layout.
  if(Array.isArray(saved) && saved.length === DEFAULT_SECTION_ORDER.length && DEFAULT_SECTION_ORDER.every(id => saved.includes(id))){
    sectionOrder = saved;
  }
}catch(e){ sectionOrder = DEFAULT_SECTION_ORDER.slice(); }

function applySectionOrder(){
  const colMain = $('#colMain');
  if(!colMain) return;
  const settings = document.getElementById('secSettings');
  sectionOrder.forEach(id => {
    const el = document.getElementById(id);
    if(el) colMain.appendChild(el);
  });
  // Settings always stays last, right below Notes by default, regardless of reordering above.
  if(settings) colMain.appendChild(settings);
}

function reorderSection(draggedId, targetId, placeAfter){
  const from = sectionOrder.indexOf(draggedId);
  if(from === -1 || draggedId === targetId) return;
  sectionOrder.splice(from, 1);
  let to = sectionOrder.indexOf(targetId);
  if(to === -1) return;
  if(placeAfter) to += 1;
  sectionOrder.splice(to, 0, draggedId);
  try{ localStorage.setItem('warroom_section_order', JSON.stringify(sectionOrder)); }catch(e){}
  applySectionOrder();
  renderSettings();
}

function setTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem('warroom_theme', theme); }catch(e){}
  renderSettings();
}

function setDensity(density){
  document.body.setAttribute('data-density', density);
  try{ localStorage.setItem('warroom_density', density); }catch(e){}
  renderSettings();
}

function setChatPosition(position){
  document.body.classList.toggle('chat-position-top', position === 'top');
  try{ localStorage.setItem('warroom_chat_position', position); }catch(e){}
  renderSettings();
}

function renderSettings(){
  const p = $('#settingsPanel');
  if(!p) return;
  const theme = localStorage.getItem('warroom_theme') || 'dark';
  const density = localStorage.getItem('warroom_density') || 'normal';

  const themeRow = `
    <div class="settings-row">
      <div class="settings-label">Theme</div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-theme-btn${theme === 'dark' ? ' active' : ''}" data-theme="dark">Dark</button>
        <button class="btn-ghost btn-small settings-theme-btn${theme === 'light' ? ' active' : ''}" data-theme="light">Light</button>
      </div>
    </div>`;

  const densityRow = `
    <div class="settings-row">
      <div class="settings-label">Table size</div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-density-btn${density === 'compact' ? ' active' : ''}" data-density="compact">Compact</button>
        <button class="btn-ghost btn-small settings-density-btn${density === 'normal' ? ' active' : ''}" data-density="normal">Normal</button>
        <button class="btn-ghost btn-small settings-density-btn${density === 'comfortable' ? ' active' : ''}" data-density="comfortable">Comfortable</button>
      </div>
    </div>`;

  const pollSeconds = Math.round(getPollIntervalMs() / 1000);
  const pollRow = `
    <div class="settings-row">
      <div class="settings-label">Live polling interval<br><span class="empty" style="padding:0;">While a war, CWL round, or raid weekend is active (10-600s)</span></div>
      <div class="settings-btns">
        <input type="number" id="pollIntervalInput" class="settings-poll-input" min="10" max="600" step="5" value="${pollSeconds}">
        <span class="empty" style="padding:0 4px;">sec</span>
        <button class="btn-ghost btn-small" id="applyPollInterval">Apply</button>
      </div>
    </div>
    <div class="empty" style="padding-top:0;">${isLiveNow ? `Currently live — refreshing every ${pollSeconds}s.` : `Currently idle — checking every ${Math.round(IDLE_POLL_MS/60000)} min for something to go live.`}</div>`;

  const chatPosition = localStorage.getItem('warroom_chat_position') === 'top' ? 'top' : 'bottom';
  const chatPositionRow = `
    <div class="settings-row">
      <div class="settings-label">AI chat position on phone/tablet<br><span class="empty" style="padding:0;">Only affects the narrow, stacked layout — desktop keeps chat on the side</span></div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-chatpos-btn${chatPosition === 'top' ? ' active' : ''}" data-chatpos="top">Top (under clan info)</button>
        <button class="btn-ghost btn-small settings-chatpos-btn${chatPosition === 'bottom' ? ' active' : ''}" data-chatpos="bottom">Bottom (default)</button>
      </div>
    </div>`;

  const orderRows = sectionOrder.map((id) => `
    <div class="settings-order-row" draggable="true" data-id="${esc(id)}">
      <span class="order-drag-handle" title="Drag to reorder">⠿</span>
      <span>${esc(SECTION_LABELS[id] || id)}</span>
    </div>`).join('');

  const body = `
    ${themeRow}
    ${densityRow}
    ${pollRow}
    ${chatPositionRow}
    <div class="settings-row settings-row-order">
      <div class="settings-label">Panel order</div>
      <div class="empty" style="padding:0;">Settings always stays last, below Notes.</div>
    </div>
    <div class="settings-order-list">${orderRows}</div>
  `;

  p.innerHTML = renderCollapsiblePanel('settingsPanel', 'Settings', body);
}

document.addEventListener('click', (e) => {
  const themeBtn = e.target.closest('.settings-theme-btn');
  if(themeBtn){ setTheme(themeBtn.dataset.theme); return; }
  const densityBtn = e.target.closest('.settings-density-btn');
  if(densityBtn){ setDensity(densityBtn.dataset.density); return; }
  const applyPollBtn = e.target.closest('#applyPollInterval');
  if(applyPollBtn){
    const input = $('#pollIntervalInput');
    const seconds = parseInt(input?.value, 10);
    if(seconds && seconds >= 10){
      setPollIntervalMs(seconds * 1000);
      renderSettings();
      renderAttackLog();
    }
    return;
  }
  const chatPosBtn = e.target.closest('.settings-chatpos-btn');
  if(chatPosBtn){ setChatPosition(chatPosBtn.dataset.chatpos); return; }
});

// --- Panel order: hold-and-drag reordering (HTML5 drag-and-drop) ---
// Delegated on the settings panel so this keeps working across every
// renderSettings() re-render, without re-binding listeners each time.
let draggedSectionId = null;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row) return;
  draggedSectionId = row.dataset.id;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedSectionId); // Firefox requires data to be set to allow the drag
});
document.addEventListener('dragend', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(row) row.classList.remove('dragging');
  document.querySelectorAll('.settings-order-row.drag-over-top, .settings-order-row.drag-over-bottom')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
  draggedSectionId = null;
});
document.addEventListener('dragover', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row || !draggedSectionId || row.dataset.id === draggedSectionId) return;
  e.preventDefault(); // required to allow a drop
  e.dataTransfer.dropEffect = 'move';
  const before = (e.clientY - row.getBoundingClientRect().top) < row.offsetHeight / 2;
  row.classList.toggle('drag-over-top', before);
  row.classList.toggle('drag-over-bottom', !before);
});
document.addEventListener('dragleave', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(row) row.classList.remove('drag-over-top', 'drag-over-bottom');
});
document.addEventListener('drop', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row || !draggedSectionId) return;
  e.preventDefault();
  const before = (e.clientY - row.getBoundingClientRect().top) < row.offsetHeight / 2;
  reorderSection(draggedSectionId, row.dataset.id, !before);
});

// Apply saved theme/density immediately (before first render) and lay out
// sections in the saved order as soon as the dashboard's markup exists.
document.documentElement.setAttribute('data-theme', localStorage.getItem('warroom_theme') || 'dark');
document.body.setAttribute('data-density', localStorage.getItem('warroom_density') || 'normal');
document.body.classList.toggle('chat-position-top', (localStorage.getItem('warroom_chat_position') || 'bottom') === 'top');
applySectionOrder();

// --- AI provider switch (Sarvam / Gemini) — persisted like the other local prefs ---
let aiProvider = localStorage.getItem('warroom_ai_provider') || 'sarvam';
const AI_PROVIDER_CONFIG = {
  sarvam: { endpoint: '/sarvam/chat', model: 'sarvam-105b', label: 'Sarvam', supportsTools: true },
  // lib/geminiProxy.js on the server translates our OpenAI-shaped
  // { messages, tools } into Gemini's contents/functionDeclarations shape
  // and translates its functionCall responses back into OpenAI-shaped
  // tool_calls, so this can now be true too.
  gemini: { endpoint: '/gemini/chat', model: 'gemini-3.6-flash', label: 'Gemini', supportsTools: true },
};
$('#aiProviderSelect').value = aiProvider;
$('#aiProviderSelect').addEventListener('change', (e) => {
  aiProvider = e.target.value;
  try{ localStorage.setItem('warroom_ai_provider', aiProvider); }catch(err){}
});

function setStatus(msg, kind){
  const el = $('#statusLine');
  el.textContent = msg || '';
  el.className = 'status-line' + (kind ? ' ' + kind : '');
}

function normalizeTag(raw){
  let t = raw.trim().toUpperCase();
  if(!t.startsWith('#')) t = '#' + t;
  return t;
}

async function cocFetch(path){
  let res;
  try{
    res = await fetch(`${LOCAL_PROXY}/coc${path}`);
  }catch(e){
    throw new Error(LOCAL_PROXY ? `Couldn't reach the local relay at ${LOCAL_PROXY}. Make sure "node coc-local-proxy.js" is running in a terminal window.` : `Couldn't reach the server. Make sure it's running.`);
  }
  if(!res.ok){
    let detail = '';
    try{ detail = (await res.json()).message || ''; }catch(e){}
    if(res.status === 403) throw new Error(`403 Forbidden — check that your CoC API key has 45.79.218.79 whitelisted as its allowed IP. ${detail}`);
    if(res.status === 404) throw new Error(`404 Not found — double check the clan tag. ${detail}`);
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

$('#connectBtn').addEventListener('click', connect);
$('#refreshBtn').addEventListener('click', () => loadAll(true));

// Auto-connect on load if a clan tag is already filled in (e.g. the default).
window.addEventListener('DOMContentLoaded', () => {
  if($('#clanTag').value.trim()) connect();
});

// --- Main nav sidebar: slide-out drawer opened via the hamburger button,
// same pattern as this app's own chat-history drawer. Each item scrolls the
// single continuously-scrollable content column to its section, then closes.
function openNavSidebar(){
  $('#navSidebar').classList.add('open');
  $('#navBackdrop').classList.add('visible');
}
function closeNavSidebar(){
  $('#navSidebar').classList.remove('open');
  $('#navBackdrop').classList.remove('visible');
}
$('#navMenuBtn').addEventListener('click', () => {
  $('#navSidebar').classList.contains('open') ? closeNavSidebar() : openNavSidebar();
});
$('#navBackdrop').addEventListener('click', closeNavSidebar);
$('#closeNavBtn').addEventListener('click', closeNavSidebar);
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    closeNavSidebar();
    if(item.dataset.mode === 'chat'){
      // AI Chat gets its own dedicated full-screen view, not just a scroll
      // to wherever the chat panel happens to sit on Home — this reuses the
      // same expand/collapse mechanism as the ⤢ button in the chat header.
      setChatExpanded(true);
      return;
    }
    const target = document.getElementById(item.dataset.target);
    if(target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// --- Draggable divider between the content column and the AI chat pane ---
(function setupSplitResizer(){
  const splitArea = document.querySelector('.split-area');
  const colMain = $('#colMain');
  const resizer = $('#splitResizer');
  let dragging = false;

  function setSplit(mainPct){
    const pct = Math.min(75, Math.max(25, mainPct));
    colMain.style.flex = `0 0 ${pct}%`;
    try{ localStorage.setItem('warroom_split_pct', String(pct)); }catch(e){}
  }

  let savedPct = 50;
  try{ const s = localStorage.getItem('warroom_split_pct'); if(s) savedPct = parseFloat(s); }catch(e){}
  setSplit(savedPct);

  function onMove(clientX){
    const rect = splitArea.getBoundingClientRect();
    setSplit(((clientX - rect.left) / rect.width) * 100);
  }
  resizer.addEventListener('mousedown', () => { dragging = true; resizer.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => { if(dragging) onMove(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; resizer.classList.remove('dragging'); document.body.style.userSelect = ''; });
  resizer.addEventListener('touchstart', () => { dragging = true; resizer.classList.add('dragging'); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if(dragging && e.touches[0]) onMove(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', () => { dragging = false; resizer.classList.remove('dragging'); });
})();

async function connect(){
  const clanTagRaw = $('#clanTag').value.trim();

  if(!clanTagRaw){
    setStatus('Enter your clan tag.', 'error');
    return;
  }
  const newTag = normalizeTag(clanTagRaw);
  if(state.clanTag && state.clanTag !== newTag){
    // Switching clans — don't carry over a chat session scoped to the old one.
    startNewChat();
  }
  state.clanTag = newTag;

  await loadAll(false);
}

// --- Live polling: while a war, CWL round, or capital raid weekend is
// actually in progress, keep re-fetching on a short timer so the dashboard
// (and the attack log) update without anyone touching Refresh. When nothing
// is live, back off to an occasional slow check just to notice something
// new starting, so it isn't hammering the CoC API for no reason 24/7.
const DEFAULT_POLL_MS = 30000;
const MIN_POLL_MS = 10000;
const MAX_POLL_MS = 600000;
const IDLE_POLL_MS = 5 * 60 * 1000;

function getPollIntervalMs(){
  let v = parseInt(localStorage.getItem('warroom_poll_interval_ms'), 10);
  if(!v || isNaN(v)) v = DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, v));
}
function setPollIntervalMs(ms){
  const clamped = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, ms));
  try{ localStorage.setItem('warroom_poll_interval_ms', String(clamped)); }catch(e){}
  restartPolling();
}

function parseCoCTimeToMs(value){
  if(!value || !/^\d{8}T/.test(value)) return NaN;
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`;
  return new Date(iso).getTime();
}

function isCapitalRaidLive(raid){
  if(!raid || !raid.startTime || !raid.endTime) return false;
  const now = Date.now();
  const start = parseCoCTimeToMs(raid.startTime);
  const end = parseCoCTimeToMs(raid.endTime);
  if(isNaN(start) || isNaN(end)) return false;
  return now >= start && now <= end;
}

function computeIsLive(){
  const warLive = !!(state.war && state.war.state === 'inWar');
  const cwlLive = !!(state.cwl && state.cwl.rounds && state.cwl.rounds.some(r => r.state === 'inWar'));
  const capitalLive = isCapitalRaidLive(state.capital?.items?.[0]);
  return warLive || cwlLive || capitalLive;
}

let isLiveNow = false;
let pollTimer = null;
let pollPaused = false; // paused while the browser tab is hidden

function currentPollMs(){ return isLiveNow ? getPollIntervalMs() : IDLE_POLL_MS; }

function restartPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if(!state.clanTag || pollPaused) return;
  pollTimer = setInterval(pollTick, currentPollMs());
  updatePollIndicator();
}

async function pollTick(){
  if(!state.clanTag || document.hidden) return;
  await loadAll(true, { silent: true });
}

document.addEventListener('visibilitychange', () => {
  pollPaused = document.hidden;
  if(!pollPaused && state.clanTag){
    // Catch up immediately on returning to the tab, then resume the timer.
    pollTick();
    restartPolling();
  } else if(pollTimer){
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

let lastPollAt = null;
function updatePollIndicator(){
  const el = $('#pollIndicator');
  if(!el) return;
  const seconds = Math.round(currentPollMs() / 1000);
  const ago = lastPollAt ? Math.max(0, Math.round((Date.now() - lastPollAt) / 1000)) : null;
  const label = isLiveNow ? `Live — refreshing every ${seconds}s` : `Idle — checking every ${seconds >= 60 ? Math.round(seconds/60) + 'm' : seconds + 's'}`;
  el.textContent = ago != null ? `${label} · updated ${ago}s ago` : label;
  el.className = 'poll-indicator' + (isLiveNow ? ' live' : '');
}
setInterval(updatePollIndicator, 5000); // keep the "updated Ns ago" bit ticking even between polls
