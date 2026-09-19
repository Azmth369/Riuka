// Read layer over the Riuka schema. Used by the HTTP endpoints (mapped back
// to the dashboard's long-standing response shapes) and by the AI context
// builder / deterministic engine. No writes here.

const { supabase } = require('./db');
const { cocStamp, epochOf } = require('./transform');

const bounded = (value, fallback, max) => Math.min(Math.max(Number(value || fallback), 1), max);

// ---------------------------------------------------------------------------
// Players + snapshots
// ---------------------------------------------------------------------------

async function getPlayers(clanTag, { limit = 100 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('name')
    .limit(bounded(limit, 100, 200));
  if (error) throw new Error(error.message);
  return (data || []).map(p => ({
    ...p,
    tag: p.tag,
    town_hall_level: p.town_hall_level,
    donations: p.donations,
    donations_received: p.donations_received,
    last_active: (p.data && p.data.last_active) || null,
    exp_level: (p.data && p.data.exp_level) || null,
  }));
}

async function getSnapshots(playerTag, { limit = 500 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('player_snapshots')
    .select('player_tag, clan_tag, captured_at, data')
    .eq('player_tag', playerTag)
    .order('captured_at', { ascending: false })
    .limit(bounded(limit, 500, 2000));
  if (error) throw new Error(error.message);
  return data || [];
}

async function getClanInfo(clanTag) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('clans')
    .select('*')
    .eq('tag', clanTag)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// ---------------------------------------------------------------------------
// Wars
// ---------------------------------------------------------------------------

// Map a wars row to the dashboard's legacy /war-history shape.
function warToLegacy(row) {
  const d = row.data || {};
  return {
    end_time: row.end_time,
    opponent_name: d.opponentName ?? null,
    team_size: d.teamSize ?? null,
    result: d.result ?? null,
    our_stars: d.ourStars ?? null,
    their_stars: d.theirStars ?? null,
    our_destruction: d.ourDestruction ?? null,
    their_destruction: d.theirDestruction ?? null,
    saved_at: row.synced_at,
  };
}

async function getWarHistory(clanTag, { limit = 200 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('wars')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('end_time', { ascending: false, nullsFirst: false })
    .limit(bounded(limit, 200, 1000));
  if (error) throw new Error(error.message);
  return (data || []).map(warToLegacy);
}

// Current = the newest war whose end time hasn't fully passed.
async function getCurrentWarRow(clanTag) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('wars')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('end_time', { ascending: false, nullsFirst: false })
    .limit(10);
  if (error) throw new Error(error.message);
  const now = Date.now();
  for (const row of data || []) {
    const endMs = row.end_time ? epochOf(row.end_time) : null;
    if (endMs == null || endMs >= now) return row;
  }
  return null;
}

async function getWarMembers(warKeyValue, { limit = 100 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('war_members')
    .select('*')
    .eq('war_key', warKeyValue)
    .order('map_position', { ascending: true, nullsFirst: true })
    .limit(bounded(limit, 100, 100));
  if (error) throw new Error(error.message);
  const byPlayer = new Map();
  for (const r of data || []) byPlayer.set(r.player_tag, r); // defensive dedupe
  return [...byPlayer.values()].map(r => ({
    war_key: r.war_key,
    player_tag: r.player_tag,
    player_name: r.player_name,
    map_position: r.map_position,
    attacks_available: r.attacks_available,
    attacks_used: r.attacks_used,
    stars_earned: r.stars_earned,
    destruction_percentage: r.destruction_percentage,
    data: r.data,
  }));
}

async function getWarAttacks(warKeyValue, { limit = 500 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('war_attacks')
    .select('*')
    .eq('war_key', warKeyValue)
    .order('order_no', { ascending: true })
    .limit(bounded(limit, 500, 1000));
  if (error) throw new Error(error.message);
  return data || [];
}

// Search wars by opponent substring and/or calendar month (YYYY-MM, IST).
async function searchWars(clanTag, { opponentContains = '', year = null, month = null, limit = 50 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('wars')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('end_time', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const monthKey = (v) => {
    const ms = epochOf(v);
    if (ms == null) return null;
    const d = new Date(ms + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const needle = String(opponentContains || '').toLowerCase();
  return (data || [])
    .filter(w => {
      if (needle && !String((w.data || {}).opponentName || '').toLowerCase().includes(needle)) return false;
      if (year && month) {
        const k = monthKey(w.end_time);
        if (k !== `${year}-${String(month).padStart(2, '0')}`) return false;
      }
      return true;
    })
    .slice(0, bounded(limit, 50, 200))
    .map(w => ({
      ...warToLegacy(w),
      war_key: w.war_key,
      start_time: w.start_time,
    }));
}

// ---------------------------------------------------------------------------
// Capital
// ---------------------------------------------------------------------------

function capitalToLegacy(row) {
  const d = row.data || {};
  return {
    start_time: d.startTime ?? null,
    total_loot: d.capitalTotalLoot ?? 0,
    raids_completed: d.raidsCompleted ?? 0,
    total_attacks: d.totalAttacks ?? 0,
    members: d.members ?? [],
    absentees: d.absentees ?? [],
    saved_at: row.synced_at,
  };
}

async function getCapitalHistory(clanTag, { limit = 100 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('capital_raids')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('synced_at', { ascending: false })
    .limit(bounded(limit, 100, 500));
  if (error) throw new Error(error.message);
  return (data || []).sort((a, b) =>
    (epochOf((b.data || {}).startTime) || 0) - (epochOf((a.data || {}).startTime) || 0)
  ).map(capitalToLegacy);
}

async function getLatestCapitalSeason(clanTag) {
  if (!supabase) return null;
  const rows = await getCapitalHistory(clanTag, { limit: 1 });
  return rows[0] || null;
}

async function getCapitalAttacks({ seasonKey, attackerContains, attackerTag, limit = 300 } = {}) {
  if (!supabase) return [];
  let q = supabase
    .from('capital_attacks')
    .select('*')
    .order('observed_at', { ascending: false })
    .limit(bounded(limit, 300, 1000));
  if (seasonKey) q = q.eq('season_key', seasonKey);
  if (attackerTag) q = q.eq('attacker_tag', attackerTag);
  if (attackerContains) q = q.ilike('attacker_name', `%${attackerContains}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function searchCapitalRaids(clanTag, { year = null, month = null, limit = 50 } = {}) {
  const rows = await getCapitalHistory(clanTag, { limit: 300 });
  if (!year || !month) return rows.slice(0, bounded(limit, 50, 200));
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const want = `${year}-${String(month).padStart(2, '0')}`;
  return rows.filter(r => {
    const ms = epochOf(r.start_time);
    if (ms == null) return false;
    const d = new Date(ms + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` === want;
  }).slice(0, bounded(limit, 50, 200));
}

// ---------------------------------------------------------------------------
// CWL
// ---------------------------------------------------------------------------

async function getCwlHistory(clanTag) {
  if (!supabase) return [];
  const { data: seasons, error } = await supabase
    .from('cwl_seasons')
    .select('*')
    .eq('clan_tag', clanTag)
    .order('season_key', { ascending: true })
    .limit(60);
  if (error) throw new Error(error.message);

  const out = [];
  for (const s of seasons || []) {
    const { data: rounds, error: rError } = await supabase
      .from('cwl_rounds')
      .select('*')
      .eq('season_key', s.season_key)
      .order('round_no', { ascending: true });
    if (rError) throw new Error(rError.message);
    out.push({
      season: (s.data || {}).season ?? String(s.season_key).split(':').pop(),
      rounds: (rounds || []).map(r => ({
        round: r.round_no,
        state: r.state,
        war_tag: r.war_tag ?? null,
        ...(r.data || {}),
      })),
      saved_at: s.synced_at,
    });
  }
  return out;
}

async function getCwlAttacks({ seasonKey, warTag, attackerTag, limit = 500 } = {}) {
  if (!supabase) return [];
  let q = supabase
    .from('cwl_attacks')
    .select('*')
    .order('observed_at', { ascending: false })
    .limit(bounded(limit, 500, 1000));
  if (seasonKey) q = q.eq('season_key', seasonKey);
  if (warTag) q = q.eq('war_tag', warTag);
  if (attackerTag) q = q.eq('attacker_tag', attackerTag);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------------------
// Cross-event attack search (the dashboard's /attack-log shape)
// ---------------------------------------------------------------------------

// Unified attack rows in the legacy shape the dashboard renders:
// { context, context_ref, attacker_tag, attacker_name, defender_tag,
//   defender_name, stars, destruction_percent, attack_order, recorded_at }
async function searchAttackLog(clanTag, { context, contextRef, attackerContains, defenderContains, limit = 500 } = {}) {
  if (!supabase) return [];
  const cap = Math.min(limit || 500, 500);
  const out = [];

  if (!context || context === 'war') {
    // war_attacks has no FK to wars, so resolve the clan's war keys first
    // (war_key embeds the clan tag, and both sides' attacks share the key).
    const { data: ourWars, error: wError } = await supabase
      .from('wars')
      .select('war_key')
      .eq('clan_tag', clanTag)
      .order('end_time', { ascending: false, nullsFirst: false })
      .limit(300);
    if (wError) throw new Error(wError.message);
    const warKeys = (ourWars || []).map(w => w.war_key);
    if (warKeys.length) {
      const { data, error } = await supabase
        .from('war_attacks')
        .select('*')
        .in('war_key', warKeys)
        .limit(cap);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        out.push({
          context: 'war',
          context_ref: r.war_key,
          attacker_tag: r.attacker_tag,
          attacker_name: r.attacker_name,
          defender_tag: r.defender_tag,
          defender_name: r.defender_name,
          stars: r.stars,
          destruction_percent: r.destruction_percentage,
          attack_order: r.order_no,
          recorded_at: r.observed_at,
        });
      }
    }
  }

  if (!context || context === 'cwl') {
    const { data, error } = await supabase
      .from('cwl_attacks')
      .select('*')
      .eq('clan_tag', clanTag)
      .limit(cap);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      out.push({
        context: 'cwl',
        context_ref: `${r.season_key}:R${r.round_no}`,
        attacker_tag: r.attacker_tag,
        attacker_name: r.attacker_name,
        defender_tag: r.defender_tag,
        defender_name: r.defender_name,
        stars: r.stars,
        destruction_percent: r.destruction_percentage,
        attack_order: r.order_no,
        recorded_at: r.observed_at,
      });
    }
  }

  if (!context || context === 'capital') {
    const { data, error } = await supabase
      .from('capital_attacks')
      .select('*')
      .eq('clan_tag', clanTag)
      .limit(cap);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      out.push({
        context: 'capital',
        context_ref: r.season_key,
        attacker_tag: r.attacker_tag,
        attacker_name: r.attacker_name,
        defender_tag: `${r.opponent_clan_tag || 'enemy'}:${r.district_id}`,
        defender_name: `${r.opponent_clan_name || 'Enemy capital'} — ${r.district_name ?? ''}`.trim(),
        stars: r.stars,
        destruction_percent: r.destruction_percentage,
        attack_order: r.attack_number,
        recorded_at: r.observed_at,
      });
    }
  }

  let filtered = out;
  if (context) filtered = filtered.filter(r => r.context === context);
  if (contextRef) {
    const want = String(contextRef);
    filtered = filtered.filter(r => {
      if (r.context === 'war') {
        // Accept any timestamp shape for the same instant (the dashboard sends
        // the raw CoC endTime; rows carry the normalized war_key).
        const keyEnd = String(r.context_ref).split(':').slice(2).join(':');
        return r.context_ref === want ||
          (epochOf(want) != null && epochOf(keyEnd) === epochOf(want));
      }
      if (r.context === 'capital') {
        const keyStart = String(r.context_ref).split(':').slice(2).join(':');
        return r.context_ref === want ||
          (epochOf(want) != null && epochOf(keyStart) === epochOf(want));
      }
      if (r.context === 'cwl') {
        // Accept both the stored "CWL:<clan>:2026-09:R2" form and the
        // dashboard's legacy "2026-09:R2" form.
        const w = String(want);
        return r.context_ref === w || String(r.context_ref).endsWith(':' + w);
      }
      return false;
    });
  }
  if (attackerContains) {
    const needle = String(attackerContains).toLowerCase();
    filtered = filtered.filter(r => String(r.attacker_name || '').toLowerCase().includes(needle));
  }
  if (defenderContains) {
    const needle = String(defenderContains).toLowerCase();
    filtered = filtered.filter(r => String(r.defender_name || '').toLowerCase().includes(needle));
  }
  return filtered.sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || ''))).slice(0, cap);
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

async function getSyncStatus({ limit = 20 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('sync_runs')
    .select('job, status, details, started_at, finished_at')
    .order('started_at', { ascending: false })
    .limit(bounded(limit, 20, 100));
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  getPlayers, getSnapshots, getClanInfo,
  getWarHistory, getCurrentWarRow, getWarMembers, getWarAttacks, searchWars,
  getCapitalHistory, getLatestCapitalSeason, getCapitalAttacks, searchCapitalRaids,
  getCwlHistory, getCwlAttacks,
  searchAttackLog, getSyncStatus,
  warToLegacy, capitalToLegacy,
};
