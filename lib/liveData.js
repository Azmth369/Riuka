// Live snapshots from the Clash of Clans API — fresher than any synced row.
// Used by the deterministic router (war state/scores first, DB fallback) and by
// the AI context builder. Everything here returns the same normalized member
// shape as war_members rows so filter code can be shared.

const cocApi = require('./cocApi');
const { cocStamp } = require('./transform');

function mapLiveMembers(members = [], attacksAvailable) {
  return (members || []).map(m => ({
    player_tag: m.tag,
    player_name: m.name,
    map_position: m.mapPosition ?? null,
    attacks_available: attacksAvailable ?? 2,
    attacks_used: (m.attacks || []).length,
    stars_earned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0),
    destruction_percentage: (m.attacks || []).reduce((s, a) => s + (a.destructionPercentage || 0), 0),
  }));
}

async function getLiveWar(clanTag) {
  let war;
  try {
    war = await cocApi.getCurrentWar(clanTag);
  } catch (e) {
    return null;
  }
  if (!war || war.state === 'notInWar' || !war.endTime) return null;

  const own = war.clan && war.clan.tag === clanTag ? war.clan : null;
  const opponent = war.clan && war.clan.tag === clanTag ? war.opponent : null;
  if (!own) return null;

  return {
    source: 'live',
    state: war.state,
    start_time: cocStamp(war.startTime),
    end_time: cocStamp(war.endTime),
    team_size: war.teamSize ?? (own.members || []).length ?? null,
    opponent: opponent ? {
      name: opponent.name ?? null,
      tag: opponent.tag ?? null,
      stars: opponent.stars ?? 0,
      destruction_percentage: opponent.destructionPercentage ?? 0,
      attacks_used: opponent.attacks ?? 0,
    } : null,
    us: {
      name: own.name ?? null,
      stars: own.stars ?? 0,
      destruction_percentage: own.destructionPercentage ?? 0,
      attacks_used: own.attacks ?? 0,
    },
    our_members: mapLiveMembers(own.members, 2),
  };
}

async function getLiveCapital(clanTag) {
  let capital;
  try {
    capital = await cocApi.getCapitalSeasons(clanTag, 1);
  } catch (e) {
    return null;
  }
  const latest = capital && capital.items && capital.items[0];
  if (!latest || !latest.startTime || !latest.endTime) return null;

  const start = cocStamp(latest.startTime);
  const end = cocStamp(latest.endTime);
  const now = Date.now();
  const state = start && end && now >= new Date(start).getTime() && now <= new Date(end).getTime()
    ? 'live' : 'ended';

  const participants = (latest.members || []).map(m => ({
    player_tag: m.tag,
    player_name: m.name,
    attacks_used: m.attacks ?? 0,
    attacks_available: (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    total_loot: m.capitalResourcesLooted ?? 0,
  }));

  return {
    source: 'live',
    state,
    start_time: start,
    end_time: end,
    raids_completed: latest.raidsCompleted ?? 0,
    total_attacks: latest.totalAttacks ?? 0,
    total_loot: latest.capitalTotalLoot ?? 0,
    participants,
  };
}

module.exports = { getLiveWar, getLiveCapital, mapLiveMembers };
