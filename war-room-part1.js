
const LOCAL_PROXY = ''; // same-origin: works locally (this server serves the page too) and once hosted on Render
const state = { clanTag:null, clan:null, war:null, warlog:null, capital:null, cwl:null, cwlHistory:[], warHistory:[], capitalHistory:[], notes:[], allNotes:[], notebook:'General', notebooks:['General'], thLevels:{}, currentConversationId:null, conversations:[], attackLog:[] };
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
// that may represent the identical instant as DIFFERENT strings â€” e.g. if a
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
// â€” the compact form is expanded into a real ISO string first so its time
// component is actually used in the conversion (skipping it would let dates
// near the UTC/IST day boundary come out a day off).
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
function formatDMY(value){
  const iso = toIsoTimestamp(value);
  if(!iso) return 'â€”';
  const date = new Date(iso);
  if(isNaN(date)) return 'â€”';
  return IST_DATE_FORMATTER.format(date); // en-GB renders as DD/MM/YYYY
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
// respecting the saved collapsee state.
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

// --- Settings: theme, table density, and section order â€” all local prefs, same pattern as above ---
const SECTION_LABELS = {
  secSummary: 'Clan Summary Details', secWar: 'Ongoing War Result', secInfo: 'Clan Info',
  secCapital: 'Ongoing Capital Raid', secAttackLog: 'Live Attack Log', secHistory: 'Full History', secNotes: 'Notes'
};
const DEFAULT_SECTION_ORDER = ['secSummary', 'secWar', 'secInfo', 'secCapital', 'secAttackLog', 'secHistory', 'secNotes'];
let sectionOrder = DEFAULT_SECTION_ORDER.slice();
try{
  const saved = JSON.parse(localStorage.getItem('warroom_section_order') || 'null');
  // Only trust a saved order if it's the same set of sections this version knows about â€”
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
      <div class="settings-label">Live polling interval<br><span class="empty"" style="padding:0;">While a war, CWL round, or raid weekend is active (10-600s)</span></div>
      <div class="settings-btns">
        <input type="number" id="pollIntervalInput" class="settings-poll-input" min="10" max="600" step="5" value="${pollSeconds}">
        <span class="empty" stym”ô‰Á…‘‘¥¹œèÀ€ÑÁàìˆùÍ•Œð½ÍÁ…¸ø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰‰Ñ¸µ¡½ÍÐ‰Ñ¸µÍµ…±°ˆ¥ô‰…ÁÁ±åA½±±%¹Ñ•ÉÙ…°ˆùÁÁ±äð½‰ÕÑÑ½¸ø(€€€€€€ð½‘¥Øø(€€€€ð½‘¥Øø(€€€€ñ‘¥Ø±…ÍÌô‰•µÁÑäˆÍÑå±”ô‰Á…‘‘¥¹œµÑ½ÀèÀìˆø‘í¥Í1¥Ù•9½Ü€üÕÉÉ•¹Ñ±ä±¥Ù”ƒŠPÉ•™É•Í¡¥¹œ•Ù•Éä€‘íÁ½±±M•½¹‘ÍõÌ¹€€èÕÉÉ•¹Ñ±ä¥‘±”ƒŠP¡•­¥¹œ•Ù•Éä€‘í5…Ñ ¹É½Õ¹¡%1}A=11}5L¼ØÀÀÀÀ¥ôµ¥¸™½ÈÍ½µ•Ñ¡¥¹œÑ¼¼±¥Ù”¹ôð½‘¥Øù€ì((€½¹ÍÐ¡…ÑA½Í¥Ñ¥½¸€ô±½…±MÑ½É…”¹•Ñ%Ñ•´ Ý…ÉÉ½½µ}¡…Ñ}Á½Í¥Ñ¥½¸œ¤€ôôô€Ñ½Àœ€ü€Ñ½Àœ€è€‰½ÑÑ½´œì(€½¹ÍÐ¡…ÑA½Í¥Ñ¥½¹I½Ü€ô€(€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹ÌµÉ½Üˆø(€€€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹Ìµ±…‰•°ˆù$¡…ÐÁ½Í¥Ñ¥½¸½¸Á¡½¹”½Ñ…‰±•Ðñ‰ÈøñÍÁ…¸±…ÍÌô‰•µÁÑäˆÍÑå±”ô‰Á…‘‘¥¹œèÀìˆù=¹±ä…™™•ÑÌÑ¡”¹…ÉÉ½Ü°ÍÑ…­•±…å½ÕÐƒŠP‘•Í­Ñ½À­••ÁÌ¡…Ð½¸Ñ¡”Í¥‘”ð½ÍÁ…¸øð½‘¥Øø(€€€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹Ìµ‰Ñ¹Ìˆø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰‰Ñ¸µ¡½ÍÐ‰Ñ¸µÍµ…±°Í•ÑÑ¥¹Ìµ¡…ÑÁ½Ìµ‰Ñ¸‘í¡…ÑA½Í¥Ñ¥½¸€ôôô€Ñ½Àœ€ü€œ…Ñ¥Ù”œ€è€œôˆ‘…Ñ„µ¡…ÑÁ½Ìô‰Ñ½ÀˆùQ½À€¡Õ¹‘•È±…¸¥¹™¼¤ð½‰ÕÑÑ½¸ø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰‰Ñ¸µ¡½ÍÐ‰Ñ¸µÍµ…±°Í•ÑÑ¥¹Ìµ¡…ÑÁ½Ìµ‰Ñ¸‘í¡…ÑA½Í¥Ñ¥½¸€ôôô€‰½ÑÑ½´œ€ü€œ…Ñ¥Ù”œ€è€œôˆ‘…Ñ„µ¡…ÑÁ½Ìô‰‰½ÑÑ½´ˆù	½ÑÑ½´€¡‘•™…Õ±Ð¤ð½‰ÕÑÑ½¸ø(€€€€€€ð½‘¥Øø(€€€€ð½‘¥Øù€ì((€½¹ÍÐ½É‘•ÉI½ÝÌ€ôÍ•Ñ¥½¹=É‘•È¹µ…À ¡¥¤€ôø€(€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Üˆ‘É……‰±”ô‰ÑÉÕ”ˆ‘…Ñ„µ¥ôˆ‘í•ÍŒ¡¥¥ôˆø(€€€€€€ñÍÁ…¸±…ÍÌô‰½É‘•Èµ‘É…œµ¡…¹‘±”ˆÑ¥Ñ±”ô‰É…œÑ¼É•½É‘•ÈˆûŠ‚üð½ÍÁ…¸ø(€€€€€€ñÍÁ…¸ø‘í•ÍŒ¡MQ%=9}1	1Mm¥‘tñð¥¥ôð½ÍÁ…¸ø(€€€€ð½‘¥Øù€¤¹©½¥¸ œœ¤ì((€½¹ÍÐ‰½‘ä€ô€(€€€€‘íÑ¡•µ•I½Ýô(€€€€‘í‘•¹Í¥ÑåI½Ýô(€€€€‘íÁ½±±I½Ýô(€€€€‘í¡…ÑA½Í¥Ñ¥½¹I½Ýô(€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹ÌµÉ½ÜÍ•ÑÑ¥¹ÌµÉ½Üµ½É‘•Èˆø(€€€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹Ìµ±…‰•°ˆùA…¹•°½É‘•Èð½‘¥Øø(€€€€€€ñ‘¥Ø±…ÍÌô‰•µÁÑäˆÍÑå±”ô‰Á…‘‘¥¹œèÀìˆùM•ÑÑ¥¹Ì…±Ý…åÌÍÑ…åÌ±…ÍÐ°‰•±½Ü9½Ñ•Ì¸ð½‘¥Øø(€€€€ð½‘¥Øø(€€€€ñ‘¥Ø±…ÍÌô‰Í•ÑÑ¥¹Ìµ½É‘•Èµ±¥ÍÐˆø‘í½É‘•ÉI½ÝÍôð½‘¥Øø(€€ì((€À¹¥¹¹•É!Q50€ôÉ•¹‘•É½±±…ÁÍ¥‰±•A…¹•° Í•ÑÑ¥¹ÍA…¹•°œ°€M•ÑÑ¥¹Ìœ°‰½‘ä¤ì)ô()‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ±¥¬œ°€¡”¤€ôøì(€½¹ÍÐÑ¡•µ•	Ñ¸€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹ÌµÑ¡•µ”µ‰Ñ¸œ¤ì(€¥˜¡Ñ¡•µ•	Ñ¸¥ìÍ•ÑQ¡•µ”¡Ñ¡•µ•	Ñ¸¹‘…Ñ…Í•Ð¹Ñ¡•µ”¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐ‘•¹Í¥Ñå	Ñ¸€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹Ìµ‘•¹Í¥Ñäµ‰Ñ¸œ¤ì(€¥˜¡‘•¹Í¥Ñå	Ñ¸¥ìÍ•Ñ•¹Í¥Ñä¡‘•¹Í¥Ñå	Ñ¸¹‘…Ñ…Í•Ð¹‘•¹Í¥Ñä¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐ…ÁÁ±åA½±±	Ñ¸€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ…ÁÁ±åA½±±%¹Ñ•ÉÙ…°œ¤ì(€¥˜¡…ÁÁ±åA½±±	Ñ¸¥ì(€€€½¹ÍÐ¥¹ÁÕÐ€ô€ œÁ½±±%¹Ñ•ÉÙ…±%¹ÁÕÐœ¤ì(€€€½¹ÍÐÍ•½¹‘Ì€ôÁ…ÉÍ•%¹Ð¡¥¹ÁÕÐü¹Ù…±Õ”°€ÄÀ¤ì(€€€¥˜¡Í•½¹‘Ì€˜˜Í•½¹‘Ì€øô€ÄÀ¥ì(€€€€€Í•ÑA½±±%¹Ñ•ÉÙ…±5Ì¡Í•½¹‘Ì€¨€ÄÀÀÀ¤ì(€€€€€É•¹‘•ÉM•ÑÑ¥¹Ì ¤ì(€€€€€É•¹‘•ÉÑÑ…­1½œ ¤ì(€€€ô(€€€É•ÑÕÉ¸ì(€ô(€½¹ÍÐ¡…ÑA½Í	Ñ¸€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹Ìµ¡…ÑÁ½Ìµ‰Ñ¸œ¤ì(€¥˜¡¡…ÑA½Í	Ñ¸¥ìÍ•Ñ¡…ÑA½Í¥Ñ¥½¸¡¡…ÑA½Í	Ñ¸¹‘…Ñ…Í•Ð¹¡…ÑÁ½Ì¤ìÉ•ÑÕÉ¸ìô)ô¤ì((¼¼€´´´A…¹•°½É‘•Èè¡½±µ…¹µ‘É…œÉ•½É‘•É¥¹œ€¡!Q50Ô‘É…œµ…¹µ‘É½À¤€´´´(¼¼•±•…Ñ•½¸Ñ¡”Í•ÑÑ¥¹ÌÁ…¹•°Í¼Ñ¡¥Ì­••ÁÌÝ½É­¥¹œ…É½ÍÌ•Ù•Éä(¼¼É•¹‘•ÉM•ÑÑ¥¹Ì ¤É”µÉ•¹‘•È°Ý¥Ñ¡½ÕÐÉ”µ‰¥¹‘¥¹œ±¥ÍÑ•¹•ÉÌ•… Ñ¥µ”¸)±•Ð‘É…•‘M•Ñ¥½¹%€ô¹Õ±°ì)‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‘É…ÍÑ…ÉÐœ°€¡”¤€ôøì(€½¹ÍÐÉ½Ü€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Üœ¤ì(€¥˜ …É½Ü¤É•ÑÕÉ¸ì(€‘É…•‘M•Ñ¥½¹%€ôÉ½Ü¹‘…Ñ…Í•Ð¹¥ì(€É½Ü¹±…ÍÍ1¥ÍÐ¹…‘ ‘É…¥¹œœ¤ì(€”¹‘…Ñ…QÉ…¹Í™•È¹•™™•Ñ±±½Ý•€ô€µ½Ù”œì(€”¹‘…Ñ…QÉ…¹Í™•È¹Í•Ñ…Ñ„ Ñ•áÐ½Á±…¥¸œ°‘É…•‘M•Ñ¥½¹%¤ì€¼¼¥É•™½àÉ•ÅÕ¥É•Ì‘…Ñ„Ñ¼‰”Í•ÐÑ¼…±±½ÜÑ¡”‘É…œ)ô¤ì)‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‘É…•¹œ°€¡”¤€ôøì(€½¹ÍÐÉ½Ü€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Üœ¤ì(€¥˜¡É½Ü¤É½Ü¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ‘É…¥¹œœ¤ì(€‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° œ¹Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Ü¹‘É…œµ½Ù•ÈµÑ½À°€¹Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Ü¹‘É…œµ½Ù•Èµ‰½ÑÑ½´œ¤(€€€€¹™½É… ¡•°€ôø•°¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ‘É…œµ½Ù•ÈµÑ½Àœ°€‘É…œµ½Ù•Èµ‰½ÑÑ½´œ¤¤ì(€‘É…•‘M•Ñ¥½¹%€ô¹Õ±°ì)ô¤ì)‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‘É…½Ù•Èœ°€¡”¤€ôøì(€½¹ÍÐÉ½Ü€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í•ÑÑ¥¹Ìµ½É‘•ÈµÉ½Üœ¤ì(€¥˜ …É½Üñð€…‘É…•‘M•Ñ¥½¹%ñðÉ½Ü¹‘…Ñ…Í•Ð¹¥€ôôô‘É…•‘M•Ñ¥½¹%¤É•ÑÕÉ¸ì(€”¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì€¼¼É•ÅÕ¥É•Ñ¼…±±½Ü„‘É½À(€”¹‘…Ñ…QÉ…¹Í™•È¹‘É½Á™™•Ð€ô€µ½Ù”œì(€½¹ÍÐ‰•™½É”€ô€¡”¹±¥•¹Ñd€´É½Ü¹•Ñ	½Õ¹‘¥¹±¥•¹ÑI•Ð ¤¹Ñ½À¤€ðÉ½Ü¹½™™Í•Ñ!•¥¡Ð€¼€Èì(€É½Ü¹±…ÍÍ1¥ÍÐ¹Ñ½±” ‘É…œµ½Ù•ÈµÑ½Àœ°‰•™½É”¤ì(€É½Ü¹±…ÍÍ1¥ÍÐ¹Ñ½±” ‘É…œµ½Ù•Èµ‰½ÑÑ½´œ°€…‰•™½É”¤ì)ô¤ì)‘½Õµ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‘É…±•…Ù”œ°€¡”¤€ôøì(€½¹ÍÐÉ½Ü€ô”¹Ñ…É•Ð¹±½Í•ÍÐ œ¹Í