// /capital-history endpoint backend on the new schema (legacy shapes).

const retrieval = require('./retrieval');
const { upsert } = require('./db');
const { cocStamp, capitalSeasonKey, mapCapitalMembers } = require('./transform');
const { findCapitalSeasonKey } = require('./sync');
const cocApi = require('./cocApi');

async function getCapitalHistory(clanTag) {
  return retrieval.getCapitalHistory(clanTag);
}

// Legacy POST shape from the browser:
//   { clanTag, startTime, totalLoot, raidsCompleted, totalAttacks, members }
// members = [{ tag, name, attacksUsed, attackLimit, loot }]
// startTime is a raw CoC stamp — normalized before any key derivation.
async function saveCapitalSeason(clanTag, season) {
  const startIso = cocStamp(season.startTime);
  if (!startIso) throw new Error('A recognizable startTime is required');

  const existingKey = await findCapitalSeasonKey(clanTag, season.startTime);
  const key = existingKey || capitalSeasonKey(clanTag, season.startTime);
  if (!key) throw new Error('Could not derive a season key');

  // Absentees: roster minus everyone in the members payload. The browser
  // sends only participants (the API only lists attackers), so we fetch the
  // roster here to record who did NOT attack — durably, on the raid row.
  let absentees = [];
  try {
    const clan = await cocApi.getClan(clanTag);
    const attackerTags = new Set((season.members || []).map(m => m.tag).filter(Boolean));
    absentees = (clan.memberList || [])
      .filter(m => m.tag && !attackerTags.has(m.tag))
      .map(m => m.name);
  } catch (e) { /* roster unavailable — skip absentees */ }

  const row = {
    clan_tag: clanTag,
    season_key: key,
    data: {
      startTime: season.startTime,
      endTime: season.endTime ?? null,
      capitalTotalLoot: season.totalLoot ?? 0,
      raidsCompleted: season.raidsCompleted ?? 0,
      totalAttacks: season.totalAttacks ?? 0,
      members: mapCapitalMembersShape(season.members),
      absentees,
    },
  };
  await upsert('capital_raids', [row], { onConflict: 'season_key' });
  return [key];
}

// Accepts either the browser's mapped shape ({attacksUsed, attackLimit, loot})
// or raw CoC member entries ({attacks, attackLimit, bonusAttackLimit,
// capitalResourcesLooted}) and returns the dashboard shape.
function mapCapitalMembersShape(members = []) {
  return (members || []).map(m => ({
    tag: m.tag,
    name: m.name,
    attacksUsed: m.attacksUsed ?? m.attacks ?? 0,
    attackLimit: m.attackLimit != null && !('bonusAttackLimit' in m)
      ? m.attackLimit
      : (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    loot: m.loot ?? m.capitalResourcesLooted ?? 0,
  }));
}

module.exports = { getCapitalHistory, saveCapitalSeason };
