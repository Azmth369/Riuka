// /cwl-history endpoint backend on the new schema (legacy shapes).
// The browser POSTs { clanTag, season, rounds } where rounds are its mapped
// summaries ({ round, state, teamSize, us, opponent, ourMembers }).

const retrieval = require('./retrieval');
const { upsert } = require('./db');
const { cwlSeasonKey } = require('./transform');
const { findCwlSeasonKey } = require('./sync');

async function getCwlHistory(clanTag) {
  return retrieval.getCwlHistory(clanTag);
}

async function saveCwlSeason(clanTag, season, rounds = []) {
  if (!season) throw new Error('season is required');
  const existingKey = await findCwlSeasonKey(clanTag, season);
  const key = existingKey || cwlSeasonKey(clanTag, season);
  if (!key) throw new Error('Could not derive a season key');

  await upsert('cwl_seasons', [{
    clan_tag: clanTag, season_key: key,
    data: { season, state: null },
  }], { onConflict: 'season_key' });

  const roundRows = rounds.map(r => ({
    clan_tag: clanTag,
    season_key: key,
    round_no: r.round,
    opponent_tag: null,
    opponent_name: (r.opponent && r.opponent.name) ?? null,
    state: r.state ?? null,
    war_tag: r.warTag ?? null,
    data: {
      teamSize: r.teamSize ?? null,
      us: r.us ?? null,
      opponent: r.opponent ?? null,
      ourMembers: r.ourMembers ?? [],
    },
  })).filter(r => r.round_no != null);

  if (roundRows.length) {
    await upsert('cwl_rounds', roundRows, { onConflict: 'season_key,round_no' });
  }
  return [key];
}

module.exports = { getCwlHistory, saveCwlSeason };
