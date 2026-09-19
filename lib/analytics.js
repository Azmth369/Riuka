// Cross-event analytics the old Riuka could never answer — enabled by the
// normalized participants tables and rolling roster snapshots.
//
//   * participationHistory : a player's wars/raids participation record,
//     including zero-attack wars (war_members keeps every roster player).
//   * memberTrends         : donation/trophy deltas over the snapshot window.
//   * quietMembers          : roster members ranked by last activity.
//   * absenteesHistory     : capital-raid absentees per weekend (durable —
//     computed on the roster as it was when each weekend began).

const { supabase } = require('./db');
const { epochOf } = require('./transform');

// How many tracked wars a player was on the roster for, how many they
// attacked in, total stars, and which wars they sat out entirely.
async function participationHistory(clanTag, playerTag, { limit = 30 } = {}) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('war_members')
    .select('war_key, player_tag, player_name, attacks_used, attacks_available, stars_earned, destruction_percentage')
    .eq('clan_tag', clanTag)
    .eq('player_tag', playerTag)
    .order('war_key', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = data || [];
  return {
    wars_on_roster: rows.length,
    wars_with_zero_attacks: rows.filter(r => Number(r.attacks_used ?? 0) === 0).length,
    total_attacks_used: rows.reduce((s, r) => s + Number(r.attacks_used ?? 0), 0),
    total_stars: rows.reduce((s, r) => s + Number(r.stars_earned ?? 0), 0),
    avg_destruction: rows.length ? +(rows.reduce((s, r) => s + Number(r.destruction_percentage ?? 0), 0) / rows.length).toFixed(2) : 0,
    recent: rows.slice(0, 10).map(r => ({
      war_key: r.war_key,
      attacks_used: r.attacks_used,
      stars_earned: r.stars_earned,
    })),
  };
}

// Donation / trophy trend for one player across the snapshot batches
// (oldest -> newest deltas).
async function memberTrends(playerTag, { limit = 200 } = {}) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('player_snapshots')
    .select('captured_at, data')
    .eq('player_tag', playerTag)
    .order('captured_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data || []).map(r => ({ captured_at: r.captured_at, ...(r.data || {}) }));
  if (rows.length < 2) return { samples: rows.length, note: 'Not enough snapshot history yet.' };
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    samples: rows.length,
    window: { from: first.captured_at, to: last.captured_at },
    donations_delta: (last.donations ?? 0) - (first.donations ?? 0),
    donations_received_delta: (last.donationsReceived ?? 0) - (first.donationsReceived ?? 0),
    trophies_delta: (last.trophies ?? 0) - (first.trophies ?? 0),
    snapshots: rows.map(r => ({ at: r.captured_at, donations: r.donations ?? 0, trophies: r.trophies ?? 0 })),
  };
}

// Roster ranked by last activity — "who's gone quiet".
async function quietMembers(clanTag, players) {
  return [...(players || [])]
    .filter(p => p.last_active)
    .sort((a, b) => epochOf(a.last_active) - epochOf(b.last_active))
    .map(p => ({ name: p.name, tag: p.tag, last_active: p.last_active }));
}

// Capital-raid absentees per weekend, newest first — the durable version of
// "who sat out" that the old dashboard could only compute for the latest raid.
async function absenteesHistory(clanTag, { limit = 20 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('capital_raids')
    .select('season_key, data')
    .eq('clan_tag', clanTag)
    .order('synced_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({
    season_key: r.season_key,
    start_time: (r.data || {}).startTime ?? null,
    absentees: (r.data || {}).absentees || [],
  })).filter(r => r.start_time);
}

module.exports = { participationHistory, memberTrends, quietMembers, absenteesHistory };
