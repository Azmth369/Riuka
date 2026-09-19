const ROLE_ORDER = { leader: 0, coLeader: 1, admin: 2, member: 3 };
const ROLE_LABEL = { leader:'Leader', coLeader:'Co-Leader', admin:'Elder', member:'Member' };

const MEMBER_COLUMNS = [
  { key: 'rank', label: '#' },
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'th', label: 'TH' },
  { key: 'level', label: 'Lvl' },
  { key: 'trophies', label: 'Trophies' },
  { key: 'donated', label: 'Donated' },
  { key: 'received', label: 'Received' }
];

function memberSortValue(m, key){
  switch(key){
    case 'rank': return m.clanRank;
    case 'name': return m.name.toLowerCase();
    case 'role': return ROLE_ORDER[m.role] ?? 9;
    case 'th': return state.thLevels[m.tag] ?? -1;
    case 'level': return m.expLevel;
    case 'trophies': return m.trophies;
    case 'donated': return m.donations;
    case 'received': return m.donationsReceived;
    default: return 0;
  }
}

function setMemberSort(key){
  if(memberSort.key === key){
    memberSort.dir = memberSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    memberSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
    if(key === 'rank') memberSort.dir = 'asc';
  }
  renderMembers();
}

async function loadTownHallLevels(force){
  if(thLoading) return;
  thLoading = true;
  const members = state.clan.memberList || [];
  if(force){ for(const m of members) delete state.thLevels[m.tag]; }
  const btn = $('#loadThBtn');
  for(let i = 0; i < members.length; i++){
    const m = members[i];
    if(state.thLevels[m.tag] != null) continue;
    if(btn) btn.textContent = `Loading TH levels... (${i+1}/${members.length})`;
    try{
      const p = await cocFetch(`/players/${encodeURIComponent(m.tag)}`);
      state.thLevels[m.tag] = p.townHallLevel ?? '—';
    }catch(e){
      state.thLevels[m.tag] = '—';
    }
    renderMembers();
  }
  thLoading = false;
  renderMembers();
}

function renderMembers(){
  const p = $('#membersPanel');
  const members = (state.clan.memberList || []).slice();
  if(members.length === 0){ p.innerHTML = renderCollapsiblePanel('membersPanel', 'Members', `<div class="empty">No member data available.</div>`); return; }

  const dirMul = memberSort.dir === 'asc' ? 1 : -1;
  members.sort((a, b) => {
    const va = memberSortValue(a, memberSort.key), vb = memberSortValue(b, memberSort.key);
    if(va < vb) return -1 * dirMul;
    if(va > vb) return 1 * dirMul;
    return 0;
  });

  const headerHtml = MEMBER_COLUMNS.map(col => {
    const arrow = memberSort.key === col.key ? (memberSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-key="${col.key}">${esc(col.label)}${arrow}</th>`;
  }).join('');

  const allRows = members.map(m => {
    const roleClass = m.role === 'leader' ? 'role-leader' : (m.role === 'coLeader' ? 'role-coLeader' : '');
    const th = state.thLevels[m.tag] ?? '—';
    return `<tr>
      <td>${esc(m.clanRank)}</td>
      <td class="name">${esc(m.name)}</td>
      <td><span class="role-badge ${roleClass}">${esc(ROLE_LABEL[m.role] || m.role)}</span></td>
      <td>${esc(th)}</td>
      <td>${esc(m.expLevel)}</td>
      <td>${esc(m.trophies)}</td>
      <td>${esc(m.donations)}</td>
      <td>${esc(m.donationsReceived)}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('membersPanel', allRows, 10);

  const needsThButton = members.some(m => state.thLevels[m.tag] == null);
  const thButtonHtml = `<button class="btn-ghost btn-small" id="loadThBtn">${needsThButton ? 'Load TH levels' : 'Refresh TH levels'}</button>`;

  const body = `
    <table>
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
  `;
  p.innerHTML = renderCollapsiblePanel('membersPanel', `Members (${members.length})`, body, thButtonHtml);

  document.querySelectorAll('#membersPanel th.sortable').forEach(th => {
    th.addEventListener('click', () => setMemberSort(th.dataset.key));
  });
  const loadBtn = $('#loadThBtn');
  if(loadBtn) loadBtn.addEventListener('click', () => loadTownHallLevels(!needsThButton));
}

function renderWarlog(){
  const p = $('#warlogPanel');
  const merged = mergedWarList();
  if(merged.length === 0){
    p.innerHTML = renderCollapsiblePanel('warlogPanel', 'War History', `<div class="empty">War log is private, and no wars have been archived yet. Play a war with this dashboard open to start building history.</div>`);
    return;
  }
  const DISPLAY_LIMIT = 25;
  const shown = merged.slice(0, DISPLAY_LIMIT);
  const allRows = shown.map(item => {
    const resClass = item.result === 'win' ? 'result-win' : (item.result === 'lose' ? 'result-lose' : 'result-tie');
    const resLabel = item.result ? item.result.charAt(0).toUpperCase() + item.result.slice(1) : '—';
    const dateLabel = formatDMY(item.endTime);
    return `<tr>
      <td>${esc(dateLabel)}</td>
      <td class="name">${esc(item.opponentName || 'Unknown')}</td>
      <td>${esc(item.teamSize ?? '—')}</td>
      <td>${esc(item.ourStars ?? '—')}★ – ${esc(item.theirStars ?? '—')}★</td>
      <td class="${resClass}">${resLabel}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('warlogPanel', allRows, 8);
  const moreNote = merged.length > DISPLAY_LIMIT ? `<div class="empty" style="padding-top:8px;">+${merged.length - DISPLAY_LIMIT} more archived in Supabase — ask the AI about older wars.</div>` : '';
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Showing ${shown.length} of ${merged.length} wars — CoC's live API only keeps the last 10, the rest are archived in Supabase.</div>
    <table>
      <thead><tr><th>Date</th><th>Opponent</th><th>Size</th><th>Stars</th><th>Result</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
    ${moreNote}
  `;
  p.innerHTML = renderCollapsiblePanel('warlogPanel', 'War History', body);
}

function renderCapital(){
  const p = $('#capitalPanel');
  const merged = mergedCapitalList();
  if(merged.length === 0){
    p.innerHTML = renderCollapsiblePanel('capitalPanel', 'Capital Raids', `<div class="empty">No raid weekend data available yet.</div>`);
    return;
  }
  const DISPLAY_LIMIT = 12;
  const shown = merged.slice(0, DISPLAY_LIMIT);
  const allRows = shown.map(s => {
    const start = formatDMY(s.startTime);
    return `<tr>
      <td class="name">${esc(start)}</td>
      <td>${(s.totalLoot ?? 0).toLocaleString()}</td>
      <td>${esc(s.raidsCompleted ?? '—')}</td>
      <td>${esc(s.totalAttacks ?? '—')}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('capitalPanel', allRows, 6);
  const moreNote = merged.length > DISPLAY_LIMIT ? `<div class="empty" style="padding-top:8px;">+${merged.length - DISPLAY_LIMIT} more archived in Supabase — ask the AI about older weekends.</div>` : '';
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Showing ${shown.length} of ${merged.length} weekends — CoC's API only keeps the last 3, the rest are archived in Supabase.</div>
    <table>
      <thead><tr><th>Weekend</th><th>Total Loot</th><th>Raids Won</th><th>Attacks Used</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
    ${moreNote}
  `;
  p.innerHTML = renderCollapsiblePanel('capitalPanel', 'Capital Raid Seasons', body);
}

const ATTACK_CONTEXT_LABEL = { war: 'War', cwl: 'CWL', capital: 'Capital' };

function renderAttackLog(){
  const p = $('#attackLogPanel');
  if(!p) return;
  const log = state.attackLog || [];
  const pollBtn = `<span class="poll-indicator" id="pollIndicator"></span>`;
  if(log.length === 0){
    p.innerHTML = renderCollapsiblePanel(
      'attackLogPanel', 'Attack Log',
      `<div class="empty">No individual attacks recorded yet. This fills in automatically — attacker, target, stars, destruction — while a war, CWL round, or raid weekend is live.</div>`,
      pollBtn
    );
    updatePollIndicator();
    return;
  }
  // Attacker/target here can each be either one of our own members or an
  // opponent, with no other column saying which — underline ours so it's
  // obvious at a glance which side someone is on.
  const ownTags = new Set((state.clan?.memberList || []).map(m => m.tag));
  // The own-member-vs-opponent ambiguity only exists for war/CWL rows —
  // capital raid attacks are always our own member attacking an enemy
  // capital district, so underlining there wouldn't distinguish anything.
  const nameCell = (name, tag, context) => {
    const label = esc(name || tag || 'Unknown');
    return (context !== 'capital' && ownTags.has(tag)) ? `<span class="own-member">${label}</span>` : label;
  };
  const allRows = log.map(a => {
    const starClass = a.stars >= 3 ? 'result-win' : (a.stars <= 0 ? 'result-lose' : 'result-tie');
    return `<tr>
      <td><span class="role-badge">${esc(ATTACK_CONTEXT_LABEL[a.context] || a.context)}</span></td>
      <td class="name">${nameCell(a.attacker_name, a.attacker_tag, a.context)}</td>
      <td>${nameCell(a.defender_name, a.defender_tag, a.context)}</td>
      <td class="${starClass}">${a.stars != null ? esc(a.stars) + '★' : '—'}</td>
      <td>${a.destruction_percent != null ? Number(a.destruction_percent).toFixed(1) + '%' : '—'}</td>
      <td>${esc(formatDMY(a.recorded_at))}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('attackLogPanel', allRows, 10);
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">${log.length} attacks recorded across war, CWL, and capital raids. In war/CWL rows, <span class="own-member">underlined</span> names are our own members.</div>
    <table>
      <thead><tr><th>Event</th><th>Attacker</th><th>Target</th><th>Stars</th><th>Destruction</th><th>Recorded</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
  `;
  p.innerHTML = renderCollapsiblePanel('attackLogPanel', `Attack Log (${log.length})`, body, pollBtn);
  updatePollIndicator();
}

function renderHistoryView(){
  if(!state.clan) return;

  // Full war history — no display cap, this is the dedicated archive view.
  const wars = mergedWarList();
  const warRows = wars.map(item => {
    const resClass = item.result === 'win' ? 'result-win' : (item.result === 'lose' ? 'result-lose' : 'result-tie');
    const resLabel = item.result ? item.result.charAt(0).toUpperCase() + item.result.slice(1) : '—';
    const dateLabel = formatDMY(item.endTime);
    return `<tr>
      <td>${esc(dateLabel)}</td>
      <td class="name">${esc(item.opponentName || 'Unknown')}</td>
      <td>${esc(item.teamSize ?? '—')}</td>
      <td>${esc(item.ourStars ?? '—')}★ – ${esc(item.theirStars ?? '—')}★</td>
      <td class="${resClass}">${resLabel}</td>
    </tr>`;
  }).join('');
  $('#warHistoryFullPanel').innerHTML = renderCollapsiblePanel('warHistoryFullPanel', `War History — ${wars.length} total`, `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Everything archived in Supabase, oldest and newest included. Grows every time this dashboard sees a war.</div>
    ${wars.length === 0
      ? `<div class="empty">Nothing archived yet.</div>`
      : `<div class="scroll-table"><table>
           <thead><tr><th>Date</th><th>Opponent</th><th>Size</th><th>Stars</th><th>Result</th></tr></thead>
           <tbody>${warRows}</tbody>
         </table></div>`}
  `);

  // Full capital raid history.
  const raids = mergedCapitalList();
  const raidRows = raids.map(s => {
    const start = formatDMY(s.startTime);
    return `<tr>
      <td class="name">${esc(start)}</td>
      <td>${(s.totalLoot ?? 0).toLocaleString()}</td>
      <td>${esc(s.raidsCompleted ?? '—')}</td>
      <td>${esc(s.totalAttacks ?? '—')}</td>
    </tr>`;
  }).join('');
  $('#capitalHistoryFullPanel').innerHTML = renderCollapsiblePanel('capitalHistoryFullPanel', `Capital Raid History — ${raids.length} total`, `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Every raid weekend archived in Supabase.</div>
    ${raids.length === 0
      ? `<div class="empty">Nothing archived yet.</div>`
      : `<div class="scroll-table"><table>
           <thead><tr><th>Weekend</th><th>Total Loot</th><th>Raids Won</th><th>Attacks Used</th></tr></thead>
           <tbody>${raidRows}</tbody>
         </table></div>`}
  `);

  // Full CWL season history (current season, if live, plus everything archived).
  const cwlSeasons = (state.cwlHistory || []).slice();
  if(state.cwl && state.cwl.season && !cwlSeasons.some(s => s.season === state.cwl.season)){
    cwlSeasons.push({ season: state.cwl.season, rounds: state.cwl.rounds });
  }
  cwlSeasons.sort((a, b) => (b.season || '').localeCompare(a.season || ''));
  const cwlRows = cwlSeasons.map(s => {
    const wins = s.rounds.filter(r => cwlRoundResult(r) === 'win').length;
    const losses = s.rounds.filter(r => cwlRoundResult(r) === 'loss').length;
    const ties = s.rounds.filter(r => cwlRoundResult(r) === 'tie').length;
    return `<tr><td class="name">${esc(s.season)}</td><td>${wins}-${losses}-${ties}</td><td>${s.rounds.length}</td></tr>`;
  }).join('');
  $('#cwlHistoryFullPanel').innerHTML = renderCollapsiblePanel('cwlHistoryFullPanel', `Clan War League History — ${cwlSeasons.length} season(s)`, `
    ${cwlSeasons.length === 0
      ? `<div class="empty">No CWL seasons archived yet.</div>`
      : `<table>
           <thead><tr><th>Season</th><th>Record (W-L-T)</th><th>Rounds</th></tr></thead>
           <tbody>${cwlRows}</tbody>
         </table>`}
  `);
}

function renderChips(){
  const suggestions = [
    "Who has the lowest donations?",
    "List the opponent's war lineup",
    "Summarize our last 10 wars",
    "Who should we consider kicking?"
  ];
  $('#chips').innerHTML = suggestions.map(s => `<button class="chip">${esc(s)}</button>`).join('');
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { $('#chatInput').value = chip.textContent; sendChat(); });
  });
}

function appendMsg(role, text){
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('#chatMessages').appendChild(div);
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  return div;
}

function formatBlock(raw){
  const lines = raw.split('\n');
  let html = '';
  let inList = false;
  for(const rawLine of lines){
    const line = rawLine.trim();
    if(line.startsWith('- ') || line.startsWith('* ')){
      if(!inList){ html += '<ul>'; inList = true; }
      html += `<li>${line.slice(2)}</li>`;
      continue;
    }
    if(inList){ html += '</ul>'; inList = false; }
    if(line === '') continue;
    html += `<p>${line}</p>`;
  }
  if(inList) html += '</ul>';
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatAiReply(raw){
  // The model is asked (see the system prompt in sendChat) to put any
  // self-checking or corrections inside a <thinking>...</thinking> block
  // before its real answer, instead of thinking out loud in the reply
  // itself. If it did that, pull the block out and render it as a
  // collapsed "Show thinking" dropdown, so only the clean final answer
  // shows by default. Older saved messages have no such block and render
  // exactly as before.
  let thinking = '';
  let answer = raw;
  const match = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if(match){
    thinking = match[1].trim();
    answer = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
  } else {
    // The reply got cut off before the model closed its <thinking> block
    // (usually hitting the token limit). Never show raw, unfinished
    // reasoning as if it were the answer — hide it behind the dropdown
    // and show a plain, honest message instead.
    const openIdx = raw.search(/<thinking>/i);
    if(openIdx !== -1){
      thinking = raw.slice(openIdx + '<thinking>'.length).trim();
      answer = raw.slice(0, openIdx).trim() ||
        "That answer got cut off while double-checking itself before finishing. Try asking again, or split it into a narrower question.";
    }
  }
  let html = '';
  if(thinking){
    html += `<details class="ai-thinking"><summary>Show thinking</summary><div class="ai-thinking-body">${formatBlock(esc(thinking))}</div></details>`;
  }
  html += formatBlock(esc(answer));
  return html;
}

// --- Persistent chat history, backed by Supabase, scoped per clan tag ---
let chatHistoryError = '';

function setChatSaveError(msg){
  chatHistoryError = msg || '';
  const el = $('#chatSaveError');
  if(!el) return;
  el.textContent = chatHistoryError;
  el.hidden = !chatHistoryError;
}

async function loadConversationList(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chats?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[chat-history] list load failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`Couldn't load saved chats (server said ${res.status}). Check the server terminal.`);
      state.conversations = [];
      return;
    }
    const body = await res.json();
    state.conversations = body.conversations || [];
  }catch(e){
    console.warn('[chat-history] list load error:', e.message);
    setChatSaveError(`Couldn't reach the server to load saved chats: ${e.message}`);
    state.conversations = [];
  }
}

function startNewChat(){
  state.currentConversationId = null;
  chatHistory = [];
  setChatSaveError('');
  $('#chatMessages').innerHTML = `<div class="msg sys">New chat. Load your clan above if you haven't, then ask away.</div>`;
  renderChatSidebarList();
}

async function openConversation(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chat-messages?conversationId=${encodeURIComponent(id)}`);
    if(!res.ok){
      console.warn('[chat-history] open failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`Couldn't open that chat — server said ${res.status}.`);
      return;
    }
    const body = await res.json();
    const messages = body.messages || [];
    state.currentConversationId = id;
    setChatSaveError('');
    chatHistory = [];
    $('#chatMessages').innerHTML = '';
    messages.forEach(m => {
      if(m.role === 'user'){
        appendMsg('user', m.content);
        chatHistory.push({ role: 'user', content: m.content });
      } else if(m.role === 'assistant'){
        const div = appendMsg('ai', '');
        div.innerHTML = formatAiReply(m.content);
        chatHistory.push({ role: 'assistant', content: m.content });
      }
    });
    if(chatHistory.length > 16) chatHistory = chatHistory.slice(-16);
    if(messages.length === 0){
      $('#chatMessages').innerHTML = `<div class="msg sys">This chat is empty.</div>`;
    }
  }catch(e){
    console.warn('[chat-history] open error:', e.message);
    setChatSaveError(`Couldn't open that chat: ${e.message}`);
  }
  renderChatSidebarList();
}

async function deleteConversationById(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if(!res.ok){ console.warn('[chat-history] delete failed:', res.status, await res.text().catch(()=>'')); return; }
    state.conversations = state.conversations.filter(c => c.id !== id);
    setPinned(id, false);
    if(state.currentConversationId === id) startNewChat();
    renderChatSidebarList();
  }catch(e){ console.warn('[chat-history] delete error:', e.message); }
}

// --- Pinning: the chats table has no pinned column, so this is tracked
// locally per-browser, scoped by clan tag. Pinned chats float to the top.
function pinnedKey(){ return `warroom_pinned_${state.clanTag || 'default'}`; }
function getPinnedIds(){
  try{ return JSON.parse(localStorage.getItem(pinnedKey()) || '[]'); }catch(e){ return []; }
}
function isPinned(id){ return getPinnedIds().includes(id); }
function setPinned(id, pinned){
  let ids = getPinnedIds();
  if(pinned && !ids.includes(id)) ids.push(id);
  if(!pinned) ids = ids.filter(x => x !== id);
  try{ localStorage.setItem(pinnedKey(), JSON.stringify(ids)); }catch(e){}
}
function togglePinned(id){
  setPinned(id, !isPinned(id));
  renderChatSidebarList();
}

function renderChatSidebarList(){
  const list = $('#chatSidebarList');
  if(!list) return;
  if(chatHistoryError){
    list.innerHTML = `<div class="save-error" style="padding:8px;">${esc(chatHistoryError)}</div>`;
    return;
  }
  if(state.conversations.length === 0){
    list.innerHTML = `<div class="chat-history-empty">No saved chats yet — ask something to start one.</div>`;
    return;
  }
  const pinnedIds = getPinnedIds();
  const pinned = state.conversations.filter(c => pinnedIds.includes(c.id));
  const rest = state.conversations.filter(c => !pinnedIds.includes(c.id));

  const renderItem = (c) => {
    const dateLabel = formatDMY(c.updated_at);
    const activeClass = c.id === state.currentConversationId ? ' active' : '';
    const pinnedNow = isPinned(c.id);
    return `<div class="chat-history-item${activeClass}" data-id="${esc(c.id)}">
      <div style="min-width:0;">
        <div class="ch-title">${esc(c.title || 'New chat')}</div>
        <div class="ch-date">${esc(dateLabel)}</div>
      </div>
      <div class="ch-btns">
        <button class="ch-pin${pinnedNow ? ' pinned' : ''}" data-id="${esc(c.id)}" title="${pinnedNow ? 'Unpin' : 'Pin'} chat">📌</button>
        <button class="ch-delete" data-id="${esc(c.id)}" title="Delete chat">×</button>
      </div>
    </div>`;
  };

  let html = '';
  if(pinned.length){
    html += `<div class="chat-sidebar-section-label">Pinned</div>` + pinned.map(renderItem).join('');
  }
  if(rest.length){
    html += `<div class="chat-sidebar-section-label">Recent</div>` + rest.map(renderItem).join('');
  }
  list.innerHTML = html;

  list.querySelectorAll('.chat-history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if(e.target.closest('.ch-delete') || e.target.closest('.ch-pin')) return;
      openConversation(item.dataset.id);
    });
  });
  list.querySelectorAll('.ch-delete').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteConversationById(btn.dataset.id); });
  });
  list.querySelectorAll('.ch-pin').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); togglePinned(btn.dataset.id); });
  });
}

function closeChatSidebar(){
  $('#chatSidebar').classList.remove('open');
  $('#historyBtn').classList.remove('on');
}

async function toggleChatSidebar(){
  const sidebar = $('#chatSidebar');
  const willOpen = !sidebar.classList.contains('open');
  if(willOpen){
    await loadConversationList();
    renderChatSidebarList();
  }
  sidebar.classList.toggle('open', willOpen);
  $('#historyBtn').classList.toggle('on', willOpen);
}

$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); }
});

$('#newChatBtn').addEventListener('click', startNewChat);
$('#historyBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleChatSidebar(); });
$('#closeSidebarBtn').addEventListener('click', closeChatSidebar);

const chatPanelEl = document.querySelector('.chat-panel');
$('#expandChat').addEventListener('click', () => setChatExpanded(!chatPanelEl.classList.contains('expanded')));
$('#chatBackdrop').addEventListener('click', () => setChatExpanded(false));

function setChatExpanded(on){
  chatPanelEl.classList.toggle('expanded', on);
  $('#chatBackdrop').classList.toggle('visible', on);
  $('#expandChat').textContent = on ? '×' : '⤢';
  $('#expandChat').title = on ? 'Collapse chat' : 'Expand chat';
}

function showLimitToast(message){
  $('#limitToastText').textContent = message;
  $('#limitToast').hidden = false;
}
function hideLimitToast(){
  $('#limitToast').hidden = true;
}
$('#limitToastClose').addEventListener('click', hideLimitToast);

async function sendChat(){
  const input = $('#chatInput');
  const question = input.value.trim();
  if(!question) return;
  if(!state.clan){ appendMsg('sys', 'Connect your clan first.'); return; }

  hideLimitToast();
  appendMsg('user', question);
  input.value = '';
  const thinkingMsg = appendMsg('ai', 'Thinking...');

  try{
    // The whole pipeline now lives on the server (lib/chatEngine.js):
    // deterministic structured query + scoped context + tools + provider
    // fallback. The browser sends only the question and, for follow-ups,
    // the conversation id — history for pronoun resolution is read
    // server-side from chat_messages, never re-sent from here.
    const res = await fetch(`${LOCAL_PROXY}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clanTag: state.clanTag,
        question,
        conversationId: state.currentConversationId || undefined,
        provider: aiProvider || undefined
      })
    });
    if(!res.ok){
      const bodyText = await res.text().catch(() => '');
      let detail = '';
      try{ detail = (JSON.parse(bodyText) || {}).error || bodyText; }catch(e){ detail = bodyText; }
      thinkingMsg.textContent = `Couldn't get a response: ${detail || res.status}`;
      return;
    }
    const data = await res.json();

    if(data.conversation_id && String(data.conversation_id) !== String(state.currentConversationId || '')){
      state.currentConversationId = data.conversation_id;
      loadConversationList().then(() => renderChatSidebarList()).catch(() => {});
    }

    thinkingMsg.innerHTML = formatAiReply(data.answer || '(empty response)');

    // Long answers are stored server-side (30 days); show a See more / See
    // less toggle that fetches the full text on demand.
    if(data.full_answer_truncated && data.answer_id){
      const more = document.createElement('button');
      more.textContent = 'See more';
      more.style.cssText = 'display:block;margin:8px 0 0;padding:4px 14px;border:1px solid rgba(128,128,128,.5);border-radius:14px;background:transparent;color:inherit;font-size:12px;cursor:pointer;';
      let fullText = null;
      more.addEventListener('click', async () => {
        if(fullText === null){
          more.textContent = 'Loading...';
          try{
            const r2 = await fetch(`${LOCAL_PROXY}/answer?id=${encodeURIComponent(data.answer_id)}`);
            if(!r2.ok){ more.textContent = 'Could not load the full answer.'; return; }
            const full = await r2.json();
            if(full.expired){ more.textContent = 'This full answer has expired.'; return; }
            fullText = full.full_answer;
            thinkingMsg.innerHTML = formatAiReply(fullText);
            more.textContent = 'See less';
            thinkingMsg.appendChild(more);
          }catch(e){ more.textContent = 'Could not load the full answer.'; }
          return;
        }
        if(more.textContent === 'See less'){
          thinkingMsg.innerHTML = formatAiReply(data.answer);
          more.textContent = 'See more';
          thinkingMsg.appendChild(more);
        } else {
          thinkingMsg.innerHTML = formatAiReply(fullText);
          more.textContent = 'See less';
          thinkingMsg.appendChild(more);
        }
      });
      thinkingMsg.appendChild(more);
    }

    // Keep the local in-memory history in sync (used when reopening chats).
    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: data.answer || '' });
    if(chatHistory.length > 16) chatHistory = chatHistory.slice(-16);
  }catch(err){
    if(err instanceof TypeError){
      thinkingMsg.textContent = LOCAL_PROXY ? `Couldn't reach the server at ${LOCAL_PROXY}. Make sure it's running.` : `Couldn't reach the server. Make sure it's running.`;
    } else {
      thinkingMsg.textContent = `Couldn't get a response: ${err.message}`;
    }
  }
}
