// Sync layer: pulls data from the Clash of Clans API and writes it into the
// Riuka Supabase schema. Every job logs to sync_runs, so a failing CoC proxy
// or Supabase is visible instead of silently staling the dashboard.
//
// Dedupe strategy (the fix for the duplicate-war bug this project once had):
//   1. war_key / season_key are derived from cocStamp()-normalized instants,
//      never raw API strings.
//   2. Before inserting a new event, the sync looks for an existing row whose
//      end/start time is within TOLERANCE_MS (2 minutes) of the payload's —
//      the currentwar and warlog endpoints sometimes report the same war with
//      an endTime a second apart, and exact-match lookups used to turn that
//      into two events.
//   3. Attack/member rows carry natural-key unique constraints, so repeated
//      polls upsert instead of duplicating.

const { supabase, upsert } = require('./db');
const cocApi = require('./cocApi');
const {
  cocStamp, epochOf, warKey, capitalSeasonKey, cwlSeasonKey,
  warRows, capitalRows, capitalAttackRows, cwlRoundRow, cwlAttackRows,
  isRegularWarEntry,
} = require('./transform');

const TOLERANCE_MS = 2 * 60 * 1000; // same-event tolerance for time matching

async function logSyncStatus(job, status, details = null) {
  try {
    if (!supabase) return;
    const { error } = await supabase.from('sync_runs').insert({
      job, status, details: details ?? undefined, finished_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (error) {
    console.error(`[${job}] failed to write sync status:`, error.message);
  }
}

// Run one sync job, log ok/error to sync_runs, never throw.
async function run(job, fn) {
  try {
    const details = await fn();
    await logSyncStatus(job, 'ok', details);
    return details;
  } catch (error) {
    await logSyncStatus(job, 'error', { message: error.message });
    console.error(`[${job}]`, error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event resolution — find an existing war/raid by instant with tolerance.
// ---------------------------------------------------------------------------

async function findWarKey(clanTag, { startTime, endTime }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('wars')
    .select('war_key, start_time, end_time')
    .eq('clan_tag', clanTag)
    .order('end_time', { ascending: false, nullsFirst: false })
    .limit(120);
  if (error) throw new Error(error.message);
  const targetEnd = epochOf(endTime);
  const targetStart = epochOf(startTime);
  for (const row of data || []) {
    if (targetStart != null && row.start_time &&
        Math.abs(epochOf(row.start_time) - targetStart) <= TOLERANCE_MS) return row.war_key;
    if (targetEnd != null && row.end_time &&
        Math.abs(epochOf(row.end_time) - targetEnd) <= TOLERANCE_MS) return row.war_key;
  }
  return null;
}

async function findCapitalSeasonKey(clanTag, startTime) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('capital_raids')
    .select('season_key, data')
    .eq('clan_tag', clanTag)
    .order('synced_at', { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const target = epochOf(startTime);
  for (const row of data || []) {
    const rowStart = epochOf(row.data && row.data.startTime);
    if (target != null && rowStart != null && Math.abs(rowStart - target) <= TOLERANCE_MS) {
      return row.season_key;
    }
  }
  return null;
}

async function findCwlSeasonKey(clanTag, season) {
  if (!supabase || !season) return null;
  const { data, error } = await supabase
    .from('cwl_seasons')
    .select('season_key, data')
    .eq('clan_tag', clanTag)
    .limit(60);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    if (row.data && row.data.season === season) return row.season_key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clan roster + snapshots
// ---------------------------------------------------------------------------

async function latestSnapshotBatch() {
  const { data, error } = await supabase
    .from('player_snapshots')
    .select('captured_at, player_tag, data')
    .order('captured_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return { time: null, players: new Map() };
  const latest = rows[0].captured_at;
  const players = new Map();
  for (const row of rows) {
    if (row.captured_at === latest) players.set(row.player_tag, row);
  }
  return { time: latest, players };
}

// Keep only the N most recent snapshot batches (default 12).
async function trimSnapshots(keep = Number(process.env.SNAPSHOT_KEEP_BATCHES ?? 12)) {
  const { data, error } = await supabase
    .from('player_snapshots')
    .select('captured_at')
    .order('captured_at', { ascending: false })
    .limit(3000);
  if (error) throw new Error(error.message);
  const times = [...new Set((data || []).map(r => r.captured_at))];
  if (times.length <= keep) return { batches: times.length, deleted: 0 };
  const cutoff = times[keep];
  const { error: delError, count } = await supabase
    .from('player_snapshots')
    .delete()
    .lt('captured_at', cutoff);
  if (delError) throw new Error(delError.message);
  return { batches: keep, deleted: count ?? null };
}

// Snapshots are taken at most every SNAPSHOT_INTERVAL_MS (default 30 minutes),
// NOT on every poll tick — otherwise the 12 retained batches would only cover
// a few minutes of history.
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 30 * 60 * 1000);

async function syncClan(clanTag, { captureSnapshots = true } = {}) {
  const clan = await cocApi.getClan(clanTag);
  const members = clan.memberList ?? [];

  await upsert('clans', [{
    tag: clan.tag, data: {
      name: clan.name, tag: clan.tag, members: clan.members,
      description: clan.description ?? null, isWarLogPublic: clan.isWarLogPublic ?? null,
    },
  }], { onConflict: 'tag' });

  await upsert('players', members.map(m => ({
    tag: m.tag,
    clan_tag: clan.tag,
    name: m.name,
    role: m.role ?? null,
    town_hall_level: m.townHallLevel ?? null,
    trophies: m.trophies ?? null,
    donations: m.donations ?? null,
    donations_received: m.donationsReceived ?? null,
    attack_wins: m.attackWins ?? null,
    defense_wins: m.defenseWins ?? null,
    data: { expLevel: m.expLevel ?? null, builderHallLevel: m.builderHallLevel ?? null },
  })), { onConflict: 'tag' });

  let snapshotInfo = null;
  if (captureSnapshots && members.length) {
    const previous = await latestSnapshotBatch();
    const sinceLastBatch = previous.time ? Date.now() - new Date(previous.time).getTime() : Infinity;
    if (sinceLastBatch < SNAPSHOT_INTERVAL_MS) {
      snapshotInfo = { snapshots: 0, note: `Skipped — last batch was ${Math.round(sinceLastBatch / 60000)} min ago (interval ${Math.round(SNAPSHOT_INTERVAL_MS / 60000)} min).` };
    } else {
    const snapshotTime = new Date().toISOString();

    const { error } = await supabase.from('player_snapshots').insert(members.map(m => ({
      player_tag: m.tag,
      clan_tag: clan.tag,
      captured_at: snapshotTime,
      data: {
        name: m.name, role: m.role ?? null, townHallLevel: m.townHallLevel ?? null,
        expLevel: m.expLevel ?? null, trophies: m.trophies ?? null,
        donations: m.donations ?? null, donationsReceived: m.donationsReceived ?? null,
      },
    })));
    if (error) throw new Error(`player_snapshots insert failed: ${error.message}`);

    // Last activity: any tracked stat changed vs the previous batch. Stored
    // on the players row (data.last_active) for quick "who's gone quiet"
    // answers without scanning snapshots.
    const changed = [];
    for (const m of members) {
      const prev = previous.players.get(m.tag);
      if (!prev) continue;
      const p = prev.data || {};
      if (p.trophies !== (m.trophies ?? null) ||
          p.donations !== (m.donations ?? null) ||
          p.donationsReceived !== (m.donationsReceived ?? null)) {
        changed.push(m.tag);
      }
    }
    if (changed.length) {
      const { data: cur, error: selError } = await supabase
        .from('players')
        .select('tag, data')
        .in('tag', changed);
      if (selError) throw new Error(selError.message);
      if (cur && cur.length) {
        await upsert('players', cur.map(row => ({
          tag: row.tag,
          data: Object.assign({}, row.data || {}, { last_active: snapshotTime }),
        })), { onConflict: 'tag' });
      }
    }

    const trimmed = await trimSnapshots();
    snapshotInfo = { snapshots: members.length, active: changed.length, lastActiveTags: changed, ...trimmed };
    }
  }

  return { members: members.length, snapshots: snapshotInfo };
}

// ---------------------------------------------------------------------------
// Regular clan war
// ---------------------------------------------------------------------------

async function saveWar(war, clanTag) {
  const existingKey = await findWarKey(clanTag, { startTime: war.startTime, endTime: war.endTime });
  const key = existingKey || warKey(clanTag, war.endTime || war.startTime);
  if (!key) return { war: null, members: 0, attacks: 0 };
  const rows = warRows(war, clanTag, key);
  if (!rows.war) return { war: null, members: 0, attacks: 0 };

  await upsert('wars', [rows.war], { onConflict: 'war_key' });
  if (rows.members.length) {
    await upsert('war_members', rows.members, { onConflict: 'war_key,clan_tag,player_tag' });
  }
  if (rows.attacks.length) {
    await upsert('war_attacks', rows.attacks, { onConflict: 'war_key,clan_tag,attacker_tag,order_no' });
  }
  return { war: key, members: rows.members.length, attacks: rows.attacks.length, reused: !!existingKey };
}

async function syncWar(clanTag) {
  const war = await cocApi.getCurrentWar(clanTag);
  if (!war || war.state === 'notInWar') return { state: 'notInWar' };
  return { state: war.state, ...(await saveWar(war, clanTag)) };
}

async function syncHistory(clanTag) {
  const clan = await cocApi.getClan(clanTag);
  if (!clan.isWarLogPublic) return { wars: 0, note: 'War log is private.' };
  const warlog = await cocApi.getWarLog(clanTag, 50);
  let saved = 0;
  for (const item of warlog.items ?? []) {
    if (!item.endTime || !isRegularWarEntry(item)) continue;
    await saveWar({ ...item, state: 'warEnded' }, clanTag);
    saved++;
  }
  return { wars: saved };
}

// ---------------------------------------------------------------------------
// Clan Capital
// ---------------------------------------------------------------------------

async function syncCapital(clanTag) {
  const seasons = await cocApi.getCapitalSeasons(clanTag, 10);
  const clan = await cocApi.getClan(clanTag);
  const roster = (clan.memberList ?? []).map(m => ({ tag: m.tag, name: m.name }));
  let raids = 0, attacks = 0;
  for (const s of seasons.items || []) {
    if (!s.startTime) continue;
    const existingKey = await findCapitalSeasonKey(clanTag, s.startTime);
    const key = existingKey || capitalSeasonKey(clanTag, s.startTime);
    if (!key) continue;
    const row = capitalRows(s, clanTag, key, roster);
    if (!row) continue;
    await upsert('capital_raids', [row], { onConflict: 'season_key' });
    const attackRows = capitalAttackRows(s, clanTag, key);
    if (attackRows.length) {
      await upsert('capital_attacks', attackRows, {
        onConflict: 'season_key,attacker_tag,district_id,attack_number,opponent_clan_tag',
      });
    }
    raids++;
    attacks += attackRows.length;
  }
  const latest = seasons.items && seasons.items[0];
  const startMs = latest && latest.startTime ? epochOf(latest.startTime) : null;
  const endMs = latest && latest.endTime ? epochOf(latest.endTime) : null;
  const live = startMs != null && endMs != null && Date.now() >= startMs && Date.now() <= endMs;
  return { raids, attacks, live };
}

// ---------------------------------------------------------------------------
// CWL
// ---------------------------------------------------------------------------

async function syncCwl(clanTag) {
  let group;
  try {
    group = await cocApi.getCwlGroup(clanTag);
  } catch (e) {
    return { state: 'notInCwl' }; // 404 = not in CWL right now — normal
  }
  if (!group || !group.rounds) return { state: 'notInCwl' };

  const existingKey = await findCwlSeasonKey(clanTag, group.season);
  const key = existingKey || cwlSeasonKey(clanTag, group.season);
  if (!key) return { state: 'notInCwl' };

  await upsert('cwl_seasons', [{
    clan_tag: clanTag, season_key: key,
    data: { season: group.season, state: group.state ?? null },
  }], { onConflict: 'season_key' });

  let wars = 0, attacks = 0, warsDataLive = false;
  for (let i = 0; i < group.rounds.length; i++) {
    const tags = (group.rounds[i].warTags || []).filter(t => t && t !== '#0');
    if (tags.length === 0) continue;
    const warsData = await Promise.all(
      tags.map(t => cocApi.getCwlWar(t).catch(() => null))
    );
    const ourWar = warsData.find(w => w && (w.clan?.tag === clanTag || w.opponent?.tag === clanTag));
    if (!ourWar) continue;
    const warTag = ourWar.tag || tags[0];

    const round = cwlRoundRow({ ...ourWar, tag: warTag }, i + 1, key, clanTag);
    if (round) {
      await upsert('cwl_rounds', [round], { onConflict: 'season_key,round_no' });
    }
    await upsert('cwl_wars', [{
      season_key: key, war_tag: warTag, clan_tag: clanTag,
      opponent_clan_tag: ourWar.opponent?.tag ?? null,
      opponent_name: ourWar.opponent?.name ?? null,
      state: ourWar.state ?? null, data: round ? round.data : {},
    }], { onConflict: 'war_tag' });

    const atk = cwlAttackRows({ ...ourWar, tag: warTag }, i + 1, key, clanTag);
    if (atk.length) {
      await upsert('cwl_attacks', atk, { onConflict: 'war_tag,clan_tag,attacker_tag,order_no' });
    }
    wars++;
    attacks += atk.length;
    if (ourWar.state === 'inWar') warsDataLive = true;
  }
  return { state: group.state ?? 'inCwl', live: warsDataLive, wars, attacks };
}

// ---------------------------------------------------------------------------
// Full tick — used by the background poller. Returns whether anything is live.
// ---------------------------------------------------------------------------

// Slower cadences so a 30s live-war tick doesn't hammer the warlog/capital
// endpoints or rewrite the roster every time. War + CWL run every tick (both
// are a single cheap call when nothing is live).
const SLOW_JOB_INTERVAL_MS = Number(process.env.SLOW_JOB_INTERVAL_MS ?? 10 * 60 * 1000); // history + capital
const CLAN_JOB_INTERVAL_MS = Number(process.env.CLAN_JOB_INTERVAL_MS ?? 2 * 60 * 1000); // roster upsert
const _lastRun = new Map();
function jobDue(job, intervalMs) {
  const last = _lastRun.get(job) || 0;
  if (Date.now() - last < intervalMs) return false;
  _lastRun.set(job, Date.now());
  return true;
}

async function fullSyncTick(clanTag) {
  let live = false;

  await run('war', async () => {
    const out = await syncWar(clanTag);
    if (out.state === 'inWar') live = true;
    return out;
  });

  await run('cwl', async () => {
    const out = await syncCwl(clanTag);
    if (out && out.live) live = true;
    return out;
  });

  if (jobDue('history', SLOW_JOB_INTERVAL_MS)) {
    await run('history', () => syncHistory(clanTag));
  }
  if (jobDue('capital', SLOW_JOB_INTERVAL_MS)) {
    await run('capital', async () => {
      const out = await syncCapital(clanTag);
      if (out && out.live) live = true;
      return out;
    });
  }
  if (jobDue('clan', CLAN_JOB_INTERVAL_MS)) {
    await run('clan', () => syncClan(clanTag));
  }

  return live;
}

module.exports = {
  run, logSyncStatus,
  syncClan, syncWar, syncHistory, syncCapital, syncCwl, fullSyncTick,
  saveWar, findWarKey, findCapitalSeasonKey, findCwlSeasonKey, trimSnapshots,
};
