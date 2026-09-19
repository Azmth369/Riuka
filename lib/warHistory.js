// /war-history endpoint backend on the new schema. Keeps the dashboard's
// long-standing request/response shapes while writing through the sync layer
// (instant-normalized keys, members + attacks recorded).

const retrieval = require('./retrieval');
const sync = require('./sync');
const cocApi = require('./cocApi');
const { warKey, warResultFromSummary, warRows, cocStamp, epochOf } = require('./transform');
const { upsert } = require('./db');

async function getWarHistory(clanTag) {
  return retrieval.getWarHistory(clanTag);
}

// Accepts the legacy POST shape from the browser:
//   { clanTag, endTime, opponentName, teamSize, result, ourStars, theirStars,
//     ourDestruction, theirDestruction, rawWar? }
// endTime arrives as the raw CoC stamp — it is normalized to an instant before
// any key is derived (the historical duplicate-war bug lived exactly here).
async function saveWar(clanTag, war) {
  const endIso = cocStamp(war.endTime);
  if (!endIso) throw new Error('A recognizable endTime is required');

  // If the browser attached the full currentwar payload, use the rich path.
  if (war.rawWar && war.rawWar.clan) {
    return sync.saveWar(war.rawWar, clanTag);
  }

  // Reuse an existing war within tolerance, else derive a fresh key.
  const existingKey = await sync.findWarKey(clanTag, { endTime: war.endTime });
  const key = existingKey || warKey(clanTag, war.endTime);

  const data = {
    opponentName: war.opponentName ?? null,
    opponentTag: war.opponentTag ?? null,
    teamSize: war.teamSize ?? null,
    result: war.result ?? null,
    ourStars: war.ourStars ?? null,
    theirStars: war.theirStars ?? null,
    ourDestruction: war.ourDestruction ?? null,
    theirDestruction: war.theirDestruction ?? null,
  };
  const row = { clan_tag: clanTag, war_key: key, state: 'warEnded', start_time: null, end_time: endIso, data };
  await upsert('wars', [row], { onConflict: 'war_key' });
  return [key];
}

module.exports = { getWarHistory, saveWar };
