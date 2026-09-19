async function loadCwlLeague(tagPath){
  // CWL isn't exposed via /currentwar â€” it lives behind its own endpoints:
  //  1) /clans/{tag}/currentwar/leaguegroup gives the round lineup (war tags per round)
  //  2) /clanwarleagues/wars/{warTag} gives the actual war detail for one round
  // The leaguegroup call 404s when the clan isn't currently in a CWL season,
  // which is normal and just means there's nothing to show.
  let group;
  try{
    group = await cocFetch(`/clans/${tagPath}/currentwar/leaguegroup`);
  }catch(e){
    return null;
  }
  if(!group || !group.rounds) return null;

  const ourTag = state.clanTag;
  const rounds = [];

  for(let i = 0; i < group.rounds.length; i++){
    const tags = (group.rounds[i].warTags || []).filter(t => t && t !== '#0');
    if(tags.length === 0) continue; // round not paired/generated yet

    const wars = await Promise.all(
      tags.map(t => cocFetch(`/clanwarleagues/wars/${encodeURIComponent(t)}`).catch(() => null))
    );
    const ourWarIdx = wars.findIndex(w => w && (w.clan?.tag === ourTag || w.opponent?.tag === ourTag));
    if(ourWarIdx === -1) continue; // our war for this round hasn't been fetched/paired yet
    const ourWar = wars[ourWarIdx];
    const ourWarTag = tags[ourWarIdx]; // real CoC war tag, used when archiving attacks

    const us = ourWar.clan?.tag === ourTag ? ourWar.clan : ourWar.opponent;
    const them = ourWar.clan?.tag === ourTag ? ourWar.opponent : ourWar.clan;

    rounds.push({
      round: i + 1,
      warTag: ourWarTag,
      state: ourWar.state,
      teamSize: ourWar.teamSize,
      us: { name: us.name, stars: us.stars ?? 0, destruction: us.destructionPercentage ?> 0, attacks: us.attacks ?? 0 },
      opponent: { name: them.name, stars: them.stars ?? 0, destruction: them.destructionPercentage ?? 0 },
      ourMembers: (us.members || []).map(m => ({
        name: m.name,
        mapPosition: m.mapPosition,
        townhallLevel: m.townhallLevel,
        attacksUsed: (m.attacks || []).length,
        starsEarned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0)
      })),
      // Kept only for extractWarAttacks() to pull individual attacks out of â€”
      // never sent to the AI context or stored in cwlHistory as-is (those
      // build their own, smaller shapes from the fields above).
      rawWar: ourWar
    });
  }

  return { season: group.season, leagueState: group.state, rounds };
}

function cwlRoundResult(r){
  if(r.us.stars !== r.opponent.stars) return r.us.stars > r.opponent.stars ? 'win' : 'loss';
  if(r.us.destruction !== r.opponent.destruction) return r.us.destruction > r.opponent.destruction ? 'win' : 'loss';
  return 'tie';
}

// CWL season history now lives in Supabase, reached through this server's
// /cwl-history route â€” the browser never talks to Supabase directly, and
// never sees the Supabase URL or keys (those stay server-side only).
async function loadCwlHistory(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/cwl-history?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.cwlHistory = []; return; }
    const body = await res.json();
    state.cwlHistory = (body.history || []).map(h => ({ season: h.season, rounds: h.rounds, savedAt: h.saved_at }));
  }catch(e){
    state.cwlHistory = [];
  }
}

async function saveCwlToHistory(cwl){
  if(!cwl || !cwl.season || !cwl.rounds || cwl.rounds.length === 0) return;
  try{
    await fetch(`${LOCAL_PROXY}/cwl-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clanTag: state.clanTag,
        season: cwl.season,
        // rawWar is only kept in-memory for extractWarAttacks() below â€” it's
        // large (full member/attack detail) and would bloat this history
        // row for no reason, since cwl_seasons only needs the summary shape.
        rounds: cwl.rounds.map(({ rawWar, ...r }) => r)
      })
    });
    // Refresh our local copy so the current season shows up in state.cwlHistory too.
    await loadCwlHistory();
  }catch(e){ /* history save failed â€” current season still renders from state.cwl */ }
}

function computeWarResult(us, opponent){
  if(us.stars !== opponent.stars) return us.stars > opponent.stars ? 'win' : 'lose';
  if(us.destructionPercentage !== opponent.destructionPercentage) return us.destructionPercentage > opponent.destructionPercentage ? 'win' : 'lose';
  return 'tie';
}

// CoC's own warlog quietly mixes in CWL season-aggregate entries: for these,
// the API blanks out the opponent and result, and reports whole-season
// totals instead of one war's stats (so star counts can look impossibly
// high for the team size). Real 1v1 wars always have an opponent name;
// these don't, so we filter them out of regular war history and let the
// dedicated CWL history (built from the leaguegroup endpoints) cover them.
function isRegularWarEntry(item){
  return !!(item.opponent && item.opponent.name);
}

function mapCapitalMembers(rawMembers){
  return (rawMembers || []).map(m => ({
    tag: m.tag,
    name: m.name,
    attacksUsed: m.attacks,
    attackLimit: (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    loot: m.capitalResourcesLooted
  }));
}

// --- Individual attack extraction, for the attack_log table ---
// Pulls every single attack (ours and the opponent's) out of a war-shaped
// object (works for both the regular /currentwar response and a CWL round's
// war, since they're the same shape). Each attack becomes one row tagged
// with a context ('war' or 'cwl') and a contextRef that identifies which
// specific war/round it belongs to, so repeated polls of the same live war
// naturally land in the same bucket.
function buildTagNameLookup(members){
  const map = new Map();
  (members || []).forEach(m => { if(m && m.tag) map.set(m.tag, m.name); });
  return map;
}

function extractWarAttacks(w, context, contextRef, warTag){
  if(!w || !w.clan || !w.opponent || !contextRef) return [];
  const ourNames = buildTagNameLookup(w.clan.members);
  const theirNames = buildTagNameLookup(w.opponent.members);
  const out = [];
  (w.clan.members || []).forEach(m => {
    (m.attacks || []).forEach(a => {
      out.push({
        context, contextRef, warTag: warTag || null,
          attackerTag: m.tag, attackerName: m.name,
          defenderTag: a.defenderTag, defenderName: theirNames.get(a.defenderTag) || null,
          stars: a.stars, destructionPercent: a.destructionPercentage, attackOrder: a.order
        });
    });
  });
  (w.opponent.members || []).forEach(m => {
    (m.attacks || []).forEach(a => {
      out.push({
        context, contextRef, warTag: warTag || null,
        attackerTag: m.tag, attackerName: m.name,
        defenderTag: a.defenderTag, defenderName: ourNames.get(a.defenderTag) || null,
        stars: a.stars, destructionPercentage: a.destructionPercentage, attackOrder: a.order
      });
    });
  });
  return out;
}

// Capital raid attacks come from a totally different shape: each entry in
// attackLog is an enemy clan we raided, broken into districts, each with its
// own list of attacks. There's no "defender player" here â€” the defender is
// a district, so defenderTag/defenderName describe that district instead.
// CoC doesn't number these attacks, so the array index stands in for
// attackOrder (stable enough across polls of the same finished data; a rare
// duplicate row here is harmless).
function extractCapitalAttacks(raidItem, contextRef){
  if(!raidItem || !contextRef) return [];
  const out = [];
  (raidItem.attackLog || []).forEach(enemy => {
    (enemy.districts || []).forEach(d => {
      (d.attacks || []).forEach((a, idx) => {
        out.push({
          context: 'capital', contextRef,
          attackerTag: a.attacker?.tag, attackerName: a.attacker?.name,
          defenderTag: `${enemy.defender?.tag || 'enemy'}:${d.id}`,
          defenderName: `${enemy.defender?.name || 'Enemy capital'}â€” ${d.name}`,
          stars: a.stars, destructionPercent: a.destructionPercent, attackOrder: idx
        });
      });
    });
  });
  return out;
}

// Gathers every attack currently visible across war/CWL/capital and upserts
// them all in one call â€” the server's unique constraint + ignoreDuplicates
// means re-posting attacks we already saved is a harmless no-op, so this can
// just be called on every loadAll() (initial connect, manual refresh, and
// every poll tick) without tracking what was already sent.
async function syncAttackLog(){
  if(!state.clanTag) return;
  const batch = [];
  if(state.war && state.war.endTime){
    batch.push(...extractWarAttacks(state.war, 'war', state.war.endTime));
  }
  if(state.cwl && state.cwl.rounds && state.cwl.season){
    state.cwl.rounds.forEach(r => {
      if(r.rawWar){
        batch.push(...extractWarAttacks(r.rawWar, 'cwl', `${state.cwl.season}:R${r.round}`, r.warTag));
      }
    });
  }
  const latestRaid = state.capital?.items?.[0];
  if(latestRaid && latestRaid.startTime){
    batch.push(...extractCapitalAttacks(latestRaid, latestRaid.startTime));
  }
  if(batch.length === 0) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/attack-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, attacks: batch })
    });
    if(!res.ok) console.warn('[attack-log] save failed:', res.status, await res.text().catch(()=>''));
  }catch(e){ console.warn('[attack-log] save error:', e.message); }
}

async function loadAttackLog(){
  if(!state.clanTag){ state.attackLog = []; return; }
  try{
    const res = await fetch(`${LOCAL_PROXY}/attack-log?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[attack-log] load failed:', res.status, await res.text().catch(()=>''));
      state.attackLog = [];
      return;
    }
    const body = await res.json();
    state.attackLog = body.log || [];
  }catch(e){
    console.warn('[attack-log] load error:', e.message);
    state.attackLog = [];
  }
}

// Regular war history now lives in Supabase too, reached through this
// server's /war-history route, same pattern as CWL history above. CoC's
// own war log only keeps the last 10 wars, so this is what lets the
// archive grow past that over time.
async function loadWazHistory(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/war-history?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ 
      console.warn('[war-history] load failed:', res.status, await res.text().catch(()=>''')); 
      state.warHistory = []; return; 
    }
    const body = await res.json();
    state.warHistory = body.history || [];
  }catch(e){
    console.warn('[war-history] load error:', e.message);
    state.warHistory = [];
  }
}

async function saveWarToHistory(war){
  if(!war || !war.endTime) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/war-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, ...war })
    });
    if(!res.ok) console.warn('[war-history] save failed:', res.status, await res.text().catch(()=>'''));
  }catch(e){ console.warn('[war-history] save error:', e.message); }
}

function mergedWarList(){
  const map = new Map();
  (state.warlog?.items || []).forEach(item => {
    if(!item.endTime || !isRegularWarEntry(item)) return;
    const key = toEpochMs(item.endTime);
    if(key == null)) return;
    map.set(key, {
      endTime: item.endTime, opponentName: item.opponent?.name || 'Unknown',
      teamSize: item.teamSize, result: item.result,
        ourStars: item.clan.stars, theirStars: item.opponent.stars
    });
  });
  if(state.war && state.war.state === 'warEnded' && state.war.endTime && isRegularWarEntry(state.war)){
    const w = state.war;
    const key = toEpochMs(w.endTime);
    if(key != null) map.set(key, {
      endTime: w.endTime, opponentName: w.opponent.name, teamSize: w.teamSize,
      result: computeWarResult(w.clan, w.opponent), ourStars: w.clan.stars, theirStars: w.opponent.stars
    });
  }
  (state.warHistory || []).forEach(h => {
    // Defensive: also drop any alreadxµ…É¡¥Ù•É½ÝÌÍ…Ù•‰•™½É”Ñ¡¥Ì™¥±Ñ•È•á¥ÍÑ•¸(€€€¥˜ … ¹•¹‘}Ñ¥µ”ñð€… ¹½ÁÁ½¹•¹Ñ}¹…µ”¤É•ÑÕÉ¸ì(€€€½¹ÍÐ­•ä€ôÑ½Á½¡5Ì¡ ¹•¹‘}Ñ¥µ”¤ì(€€€¥˜¡­•ä€ôô¹Õ±°ñðµ…À¹¡…Ì¡­•ä¤¤¤É•ÑÕÉ¸ì(€€€µ…À¹Í•Ð¡­•ä°ì(€€€€€•¹‘Q¥µ”è ¹•¹‘}Ñ¥µ”°½ÁÁ½¹•¹Ñ9…µ”è ¹½ÁÁ½¹•¹Ñ}¹…µ”ñð€U¹­¹½Ý¸œ°(€€€€€Ñ•…µM¥é”è ¹Ñ•…µ}Í¥é”°É•ÍÕ±Ðè ¹É•ÍÕ±Ð°(€€€€€½ÕÉMÑ…ÉÌè ¹½ÕÉ}ÍÑ…ÉÌ°Ñ¡•¥ÉMÑ…ÉÌè ¹Ñ¡•¥É}ÍÑ…ÉÌ(€€€ô¤ì(€ô¤ì(€É•ÑÕÉ¸ÉÉ…ä¹™É½´¡µ…À¹Ù…±Õ•Ì ¤¤¹Í½ÉÐ ¡„°ˆ¤€ôø€¡Ñ½Á½¡5Ì¡ˆ¹•¹‘Q¥µ”¤ñð€À¤€´€¡Ñ½Á½¡5Ì¡„¹•¹‘Q¥µ”¤ñð€À¤¤ì)ô((¼¼…Á¥Ñ…°É…¥¡¥ÍÑ½ÉäƒŠPÍ…µ”¥‘•„¸½ÌA$½¹±ä­••ÁÌÑ¡”±…ÍÐ™•Ü(¼¼Ý••­•¹‘Ì°Í¼…¹åÑ¡¥¹œ½±‘•È½¹±ä•á¥ÍÑÌ‰•…ÕÍ”Ý”Í…Ù•¥Ð¡•É”¸)™Õ¹Ñ¥½¸±½…‘…Á¥Ñ…±!¥ÍÑ½Éä ¥ì(€ÑÉåì(€€€½¹ÍÐÉ•Ì€ô…Ý…¥Ð™•Ñ ¡€‘í1=1}AI=aeô½…Á¥Ñ…°µ¡¥ÍÑ½Éäý±…¹Q…œô‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÍÑ…Ñ”¹±…¹Q…œ¥õ€¤ì(€€€¥˜ …É•Ì¹½¬¥ì(€€€€€½¹Í½±”¹Ý…É¸ m…Á¥Ñ…°µ¡¥ÍÑ½Éåt±½…™…¥±•èœ°É•Ì¹ÍÑ…ÑÕÌ°…Ý…¥ÐÉ•Ì¹Ñ•áÐ ¤¹…Ñ   ¤ôøœœœ¤¤ì(€€€€€ÍÑ…Ñ”¹…Á¥Ñ…±!¥ÍÑ½Éä€ômtìÉ•ÑÕÉ¸ì€(€€€ô(€€€½¹ÍÐ‰½‘ä€ô…Ý…¥ÐÉ•Ì¹©Í½¸ ¤ì(€€€ÍÑ…Ñ”¹…Á¥Ñ…±!¥ÍÑ½Éä€ô‰½‘ä¹¡¥ÍÑ½Éäñðmtì(€õ…Ñ ¡”¥ì(€€€½¹Í½±”¹Ý…É¸ m…Á¥Ñ…°µ¡¥ÍÑ½Éåt±½…•ÉÉ½Èèœ°”¹µ•ÍÍ…”¤ì(€€€ÍÑ…Ñ”¹…Á¥Ñ…±!¥ÍÑ½Éä€ômtì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•…Á¥Ñ…±Q½!¥ÍÑ½Éä¡Í•…Í½¸¥ì(€¥˜ …Í•…Í½¸ñð€…Í•…Í½¸¹ÍÑ…ÉÑQ¥µ”¤É•ÑÕÉ¸ì(€ÑÉåì(€€€½¹ÍÐÉ•Ì€ô…Ý…¥Ð™•Ñ ¡€‘í1=1}AI=aeô½…Á¥Ñ…°µ¡¥ÍÑ½Éå€°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµQåÁ”œè€…ÁÁ±¥…Ñ¥½¸½©Í½¸œô°(€€€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì±…¹Q…œèÍÑ…Ñ”¹±…¹Q…œ°€¸¸¹Í•…Í½¸ô¤(€€€ô¤ì(€€€¥˜ …É•Ì¹½¬¤½¹Í½±”¹Ý…É¸ m…Á¥Ñ…°µ¡¥ÍÑ½ÉåtÍ…Ù”™…¥±•èœ°É•Ì¹ÍÑ…ÑÕÌ°…Ý…¥ÐÉ•Ì¹Ñ•áÐ ¤¹…Ñ   ¤ôøœœœ¤¤ì(€õ…Ñ ¡”¥ì½¹Í½±”¹Ý…É¸ m…Á¥Ñ…°µ¡¥ÍÑ½ÉåtÍ…Ù”•ÉÉ½Èèœ°”¹µ•ÍÍ…”¤ìô)ô()™Õ¹Ñ¥½¸µ•É•‘…Á¥Ñ…±1¥ÍÐ ¥ì(€½¹ÍÐµ…À€ô¹•Ü5…À ¤ì(€€¡ÍÑ…Ñ”¹…Á¥Ñ…°ü¹¥Ñ•µÌñðmt¤¹™½É… ¡Ì€ôøì(€€€¥˜ …Ì¹ÍÑ…ÉÑQ¥µ”¤É•ÑÕÉ¸ì(€€€½¹ÍÐ­•ä€ôÑ½Á½¡5Ì¡Ì¹ÍÑ…ÉÑQ¥µ”¤ì(€€€¥˜¡­•ä€ôô¹Õ±°¤¤É•ÑÕÉ¸ì(€€€µ…À¹Í•Ð¡­•ä°ì(€€€€€ÍÑ…ÉÑQ¥µ”èÌ¹ÍÑ…ÉÑQ¥µ”°Ñ½Ñ…±1½½ÐèÌ¹…Á¥Ñ…±Q½Ñ…±1½½Ð°(€€€€€É…¥‘Í½µÁ±•Ñ•èÌ¹É…¥‘Í½µÁ±•Ñ•°Ñ½Ñ…±ÑÑ…­ÌèÌ¹Ñ½Ñ…±ÑÑ…­Ì°(€€€€€µ•µ‰•ÉÌèµ…Á…Á¥Ñ…±5•µ‰•ÉÌ¡Ì¹µ•µ‰•ÉÌ¤(€€€ô¤ì(€ô¤ì(€€¡ÍÑ…Ñ”¹…Á¥Ñ…±!¥ÍÑ½Éäñðmt¤¹™½É… ¡ €ôøì(€€€¥˜ … ¹ÍÑ…ÉÑ}Ñ¥µ”¤É•ÑÕÉ¸ì(€€€½¹ÍÐ­•ä€ôÑ½Á½¡5s(h.start_time);
    if(key == null || map.has(key)) return;
    map.set(key, {
      startTime: h.start_time, totalLoot: h.total_loot,
      raidsCompleted: h.raids_completed, totalAttacks: h.total_attacks,
      members: h.members || []
    });
  });
  return Array.from(map.values()).sort((a, b) => (toEpochMs(b.startTime) || 0) - (toEpochMs(a.startTime) || 0));
}

// --- Notebook, backed by Supabase, scoped per clan tag AND per notebook ---
// (a note belongs to exactly one notebook, like a folder â€” 'General' by
// default; see notes-migration.sql for the schema change this needs).
let notesError = '';

async function loadNotebooks(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notebooks?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.notebooks = ['General']; return; }
    const body = await res.json();
    state.notebooks = (body.notebooks && body.notebooks.length) ? body.notebooks : ['General'];
    if(!state.notebooks.includes(state.notebook)) state.notebook = state.notebooks[0];
  }catch(e){
    console.warn('[notebooks] load error:', e.message);
    state.notebooks = ['General'];
  }
}

// Every note across every notebook â€” kept separately from state.notes (which
// is scoped to whichever notebook the panel is currently showing) so the AI
// chat's context always sees the whole notebook archive, not just whatever
// happens to be open in the UI right now.
async function loadAllNotes(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.allNotes = []; return; }
    const body = await res.json();
    state.allNotes = body.notes || [];
  }catch(e){
    console.warn('[notes] load-all error:', e.message);
    state.allNotes = [];
  }
}

async function loadNotes(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}&notebook=${encodeURIComponent(state.notebook)}`);
    if(!res.ok){
      const body = await res.text().catch(()=>''');
      console.warn('[notes] load failed:', res.status, body);
      notesError = `Couldn't load notes (server said ${res.status}). Check the server terminal for details.`;
      state.notes = [];
      return;
    }
    const body = await res.json();
    state.notes = body.notes || [];
    notesError = '';
  }catch(e){
    console.warn('[notes] load error:', e.message);
    notesError = `Couldn't reach the server to load notes: ${e.message}`;
    state.notes = [];
  }
}

async function switchNotebook(name){
  if(!name || name === state.notebook) return;
  state.notebook = name;
  await loadNotes();
  renderNotes();
}

async function createNotebook(name){
  const trimmed = (name || '').trim();
  if(!trimmed) return;
  // The notebook itself isn't a row anywhere â€” it only really exists once a
  // note is saved to it â€” so just switch to it now (adding it to the local
  // list so the picker shows it right away and let addNote() create the
  // first real row when the person actually writes something.
  if(!state.notebooks.includes(trimmed)) state.notebooks = [...state.notebooks, trimmed].sort((a,b) => a.localeCompare(b));
  await switchNotebook(trimmed);
}

async function addNote(content){
  if(!content || !content.trim()) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, content: content.trim(), notebook: state.notebook })
    });
    if(res.ok){
      notesError = '';
      await Promise.all([loadNotes(), loadAllNotes(), loadNotebooks()]);
      renderNotes();
    } else {
      const body = await res.text().catch(()=>''');
      console.warn('[notes] save failed:', res.status, body);
      notesError = `Note wasn't saved â€” server said ${res.status}. Check the server terminal for details.`;
      renderNotes();
    }
  }catch(e){
    console.warn('[notes] save error:', e.message);
    notesError = `NOte wasn't saved â€” couldn't reach the server: ${e.message}`;
    renderNotes();
  }
}

async function deleteNoteById(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if(!res.ok){ console.warn('[notes] delete failed:', res.status, await res.text().catch(()=>''')); return; }
    state.notes = state.notes.filter(n => n.id !== id);
    state.allNotes = state.allNotes.filter(n => n.id !== id);
    renderNotes();
  }catch(e){ console.warn('[notes] delete error:', e.message); }
}

function renderNotes(){
  const p = $('#notesPanel');
  if(!p) return;
  const rows = state.notes.map(n => {
    const dateLabel = formatDMY(n.created_at);
    return `<div class="note-item">
      <div class="note-text">${esc(n.content)}</div>
      <div class="note-meta">
        <span>${esc(dateLabel)}</span>
        <button class="note-delete" data-id="${esc(n.id)}" title="Delete note">Ã—</button>
      </div>
    </div>`;
  }).join('');
  const notebookOptions = state.notebooks.map(nb => `<option value="${esc(nb)}" ${nb === state.notebook ? 'selected' : ''}>${esc(nb)}</option>`).join('');
  const body = `
    <div class="notebook-picker-row">
      <select id="notebookSelect" title="Switch notebook">${notebookOptions}</select>
      <button class="btn-ghost btn-small" id="newNotebookBtn" title="Create a new notebook">+ New notebook</button>
    </div>
    <div class="note-add-row">
      <textarea id="noteInput" placeholder="Jot something down â€” a decision, a reminder, a lineup idea..."></textarea>
      <button class="btn btn-small" id="addNoteBtn">Add</button>
    </div>
    ${notesError ? `<div class="save-error">${esc(notesError)}</div>` : ''}
    <div class="note-list">
      ${rows || `<div class="empty">No notes yet in "${esc(state.notebook)}".</div>`}
    </div>
  `;
  p.innerHTML = renderCollapsiblePanel('notesPanel', `Notebook: ${esc(state.notebook)}${state.notes.length ? ` (${state.notes.length})` : ''}`, body);
  $('#notebookSelect').addEventListener('change', (e) => switchNotebook(e.target.value));
  $('#newNotebookBtn').addEventListener('click', () => {
    const name = prompt('Name for the new notebook:');
    if(name) createNotebook(name);
  });
  $('#addNoteBtn').addEventListener('click', () => {
    const input = $('#noteInput');
    addNote(input.value);
    input.value = '';
  });
  document.querySelectorAll('.note-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteNoteById(btn.dataset.id));
  });
}

async function loadAll(isRefresh, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  const btn = isRefresh ? $('#refreshBtn') : $('#connectBtn');
  if(!silent){ btn.disabled = true; setStatus('Connecting to your clan...', 'loading'); }

  try{
    const tagPath = encodeURIComponent(state.clanTag);
    await loadCwlHistory();
    await loadWarHistory();
    await loadCapitalHistory();
    await loadNotebooks();
    await loadNotes();
    await loadAllNotes();
    state.clan = await cocFetch(`/clans/${tagPath}`);

    if(!silent) setStatus('Loading current war...', 'loading');
    try{ state.war = await cocFetch(`/clans/${tagPath}/currentwar`); }
    catch(e){ state.war = null; }

    if(state.war && state.war.state === 'warEnded' && state.war.endTime){
      saveWarToHistory({
        endTime: state.war.endTime,
        opponentName: state.war.opponent.name,
        teamSize: state.war.teamSize,
        result: computeWarResult(state.war.clan, state.war.opponent),
        ourStars: state.war.clan.stars,
          theirStars: state.war.opponent.stars,
        ourDestruction: state.war.clan.destructionPercentage,
        theirDestruction: state.war.opponent.destructionPercentage
      }); // fire-and-forget
    }

    if(state.clan.isWarLogPublic){
      if(!silent) setStatus('Loading war log...', 'loading');
      try{ state.warlog = await cocFetch(`/clans/${tagPath}/warlog?limit=10`); }
      catch(e){ state.warlog = null; }
    } else {
      state.warlog = null;
    }

    // Backfill: every publicly visible past war gets saved too, so the
    // archive keeps growing even if the war log later turns private.
    // CWL aggregate entries (no opponent name) are skipped â€” they're not
    // real 1v1 wars and their stats are season totals, not war totals.
    (state.warlog?.items || []).forEach(item => {
      if(!item.endTime || !isRegularWarEntry(item)) return;
      saveWarToHistory({
        endTime: item.endTime,
        opponentName: item.opponent?.name,
        teamSize: item.teamSize,
        result: item.result,
        ourStars: item.clan.stars,
        theirStars: item.opponent.stars,
        ourDestruction: item.clan.destructionPercentage,
        theirDestruction: item.opponent.destructionPercentage
      });
    });

    if(!silent) setStatus('Loading capital raids...', 'loading');
    try{ state.capital = await cocFetch(`/clans/${tagPath}/capitalraidseasons?limit=3`); }
    catch(e){ state.capital = null; }

    (state.capital?.items || []).forEach(s => {
      if(!s.startTime) return;
      saveCapitalToHistory({
        startTime: s.startTime,
        totalLoot: s.capitalTotalLoot,
        raidsCompleted: s.raidsCompleted,
        totalAttacks: s.totalAttacks,
        members: mapCapitalMembers(s.members)
      });
    });

    if(!silent) setStatus('Checking for Clan War League...', 'loading');
    try{ state.cwl = await loadCwlLeague(tagPath); }
    catch(e){ state.cwl = null; }
    saveCwlToHistory(state.cwl); // fire-and-forget: don't block dashboard render on the history write

    // Pull every attack currently visible (war/CWL/capital) into Supabase,
    // then reload the merged log from there for display + the AI context.
    await syncAttackLog();
    await loadAttackLog();

    renderAll();
    $('#setupPanel').style.marginBottom = '20px';
    $('#dashboard').hidden = false;
    if(!silent){
      setStatus(`Connected â€” showing ${state.clan.name}.`, 'ok');
      setSetupCollapsed(true);
    }

    // Switch polling cadence immediately if a war/CWL round/raid just
    // started or just ended, instead of waiting for the next tick.
    lastPollAt = Date.now();
    const nowLive = computeIsLive();
    if(nowLive !== isLiveNow || !pollTimer){
      isLiveNow = nowLive;
      restartPolling();
    } else {
      updatePollIndicator();
    }

    if(!silent) loadTownHallLevels(); // fire-and-forget: dashboard is already usable, THIS column backfills as this completes
  }catch(err){
    if(!silent) setStatus(err.message, 'error');
    else console.warn('[pull] silent refresh failed:', err.message);
  }finally{
    if(!silent) btn.disabled = false;
  }
}

function renderAll(){
  renderHero();
  renderWar();
  renderCwl();
  renderMembers();
  renderWarlog();
  renderCapital();
  renderAttackLog();
  renderNotes();
  renderChips();
  renderHistoryView();
  renderSettings();
}

function renderHero(){
  const c = state.clan;
  $('#clanHero').innerHTML = `
    <img src="${esc(c.badgeUrls?.medium || '')}" alt="" />
    <div>
      <div class="name">${esc(c.name)} <span class="tag">${esc(c.tag)}</span></div>
      <div class="desc">${esc(c.description || '')}</div>
    </div>
    <div class="stat-strip">
      <div class="stat"><div class="v">${esc(c.clanLevel)}</div><div class="l">Level</div></div>
      <div class="stat"><div class="v">${esc(c.members)}/50</div><div class="l">Members</div></div>
      <div class="stat"><div class="v">${esc(c.warWinStreak)}</div><div class="l">Win Streak</div></div>
      <div class="stat"><div class="v">${esc(c.warWins ?? 'â€´})}</div><div class="l">War Wins</div></div>
      <div class="stat"><div class="v">${esc(c.clanCapital?.capitalWarLevel ?? 'â€´')}</div><div class="l">Capital Hall</div></div>
    </div>
  `;
}

function renderWar(){
  const p = $('#warPanel');
  const w = state.war;
  if(!w || w.state === 'notInWar'){
    p.innerHTML = renderCollapsiblePanel('warPanel', 'Current War', `<div class="empty">Not currently in a war, or the clan's current-war data is private.</div>`);
    return;
  }
  const stateClass = { inWar:'ws-inWar', warEnded:'ws-warEnded', preparation:'ws-preparation' }[w.state] || 'ws-none';
  const stateLabel = { inWar:'Battle Day', warEnded:'War Ended', preparation:'Preparation Day' }[w.state] || w.state;

  const body = `
    <span class="war-state ${stateClass}">${esc(stateLabel)}</span>
    <div class="war-vs">
      <div class="war-side">
        <div class="clan-name">${esc(w.clan.name)}</div>
        <div class="stars">${esc(w.clan.stars ?? 0)}â˜…</div>
        <div class="destro">${(w.clan.destructionPercentage ?? 0).toFixed(1)}% destruction</div>
      </div>
      <div class="war-mid">vs</div>
      <div class="war-side">
        <div class="clan-name">${esc(w.opponent.name)}</div>
        <div class="stars">${esc(w.opponent.stars ?? 0)}â˜…</div>
        <div class="destro">${(w.opponent.destructionPercentage ?? 0).toFixed(1)}% destruction</div>
      </div>
    </div>
    <div class="empty" style="padding-top:0;">Team size: ${esc(w.teamSize)} Â· Attacks per member: ${esc(w.attacksPerMember ?? 1)} Â· Attacks used: ${esc(w.clan.attacks ?? 0)}</div>
  `;
  p.innerHTML = renderCollapsiblePanel('warPanel', 'Current War', body);
}

function renderCwl(){
  const p = $('#cwlPanel');
  const cwl = state.cwl;
  const history = (state.cwlHistory || []).filter(s => !cwl || s.season !== cwl.season);
  let panelTitle = 'Clan War League';

  let html = '';
  if(!cwl || !cwl.rounds || cwl.rounds.length === 0){
    html += `<div class="empty">Not currently in a CWL season (or this season hasn't started pairing wars yet).</div>`;
  } else {
    const stateClass = { inWar:'ws-inWar', warEnded:'ws-warEnded', preparation:'ws-preparation' };
    const stateLabel = { inWar:'Battle Day', warEnded:'War Ended', preparation:'Preparation Day' };
    const rows = cwl.rounds.map(r => {
      const cls = stateClass[r.state] || 'ws-none';
      const label = stateLabel[r.state] || r.state;
      return `
        <div class="war-vs" style="margin-bottom:6px;">
          <div class="war-side">
            <div class="clan-name">${esc(r.us.name)}</div>
            <div class="stars">${esc(r.us.stars)}â˜…</div>
            <div class="destro">${r.us.destruction.toFixed(1)}%</div>
          </div>
          <div class="war-mid">Round ${r.round}<br/><span class="war-state ${cls}" style="margin-top:4px;">${esc(label)}</span></div>
          <div class="war-side">
            <div class="clan-name">${esc(r.opponent.name)}</div>
            <div class="stars">${esc(r.opponent.stars)}â˜…</div>
            <div class="destro">${r.opponent.destruction.toFixed(1)}%</div>
          </div>
        </div>`;
    }).join('<hr style="border-color:#262b34;border-style:solid;margin:10px 0;">');
    panelTitle = `Clan War League â€” Season ${esc(cwl.season || '')}`;
    html += rows;
  }

  if(history.length > 0){
    const histRows = history.slice().reverse().map(s => {
      const wins = s.rounds.filter(r => cwlRoundResult(r) === 'win').length;
      const losses = s.rounds.filter(r => cwlRoundResult(r) === 'loss').length;
      const ties = s.rounds.filter(r => cwlRoundResult(r) === 'tie').length;
      return `<tr><td class="name">${esc(s.season)}</td><td>${wins}-${losses}-${ties}</td><td>${s.rounds.length}</td></tr>`;
    }).join('');
    html += `
      <h3 style="margin-top:18px;"><span class="dot"></span>Past CWL Seasons</h3>
      <div class="empty" style="padding-top:0;margin-bottom:8px;">Saved automatically on this browser while a season is live â€” the API itself keeps no history.</div>
      <table>
        <thead><tr><th>Season</th><th>Record (W-L-T)</th><th>Rounds</th></tr></thead>
        <tbody>${histRows}</tbody>
      </table>`;
  }

  p.innerHTML = renderCollapsiblePanel('cwlPanel', panelTitle, html);
}
