// /attack-log endpoint backend on the new schema. The GET returns the legacy
// unified shape (context/context_ref/...) from war/capital/cwl attack tables.
// The POST accepts the browser's batch and routes each attack to the right
// table; keys are derived from normalized instants so re-polls never duplicate.

const retrieval = require('./retrieval');
const { upsert } = require('./db');
const { cocStamp, warKey, capitalSeasonKey, cwlSeasonKey, epochOf } = require('./transform');
const { findWarKey, findCapitalSeasonKey, findCwlSeasonKey } = require('./sync');

async function getAttackLog(clanTag, opts = {}) {
  return retrieval.searchAttackLog(clanTag, opts);
}

// Browser rows look like:
//   { context: 'war'|'cwl'|'capital', contextRef, attackerTag, attackerName,
//     defenderTag, defenderName, stars, destructionPercent, attackOrder,
//     warTag? (cwl only, when the browser knows it) }
async function saveAttacks(clanTag, attacks = []) {
  if (!attacks || attacks.length === 0) return [];
  const warRows = [];
  const capitalRows = [];
  const cwlRows = [];
  let skipped = 0;

  for (const a of attacks) {
    const context = String(a.context || '');
    if (context === 'war') {
      // Resolve the war by instant (tolerant), deriving a key if new.
      const ref = a.contextRef;
      let key = await findWarKey(clanTag, { endTime: ref });
      if (!key) {
        const iso = cocStamp(ref);
        key = iso ? warKey(clanTag, ref) : null;
      }
      if (!key || !a.attackerTag || a.attackOrder == null) { skipped++; continue; }
      warRows.push({
        war_key: key,
        clan_tag: clanTag,
        attacker_tag: a.attackerTag,
        attacker_name: a.attackerName ?? null,
        defender_tag: a.defenderTag != null ? String(a.defenderTag) : null,
        defender_name: a.defenderName ?? null,
        stars: a.stars ?? null,
        destruction_percentage: a.destructionPercent ?? null,
        order_no: a.attackOrder,
        data: {},
      });
    } else if (context === 'capital') {
      let key = await findCapitalSeasonKey(clanTag, a.contextRef);
      if (!key) {
        const iso = cocStamp(a.contextRef);
        key = iso ? capitalSeasonKey(clanTag, a.contextRef) : null;
      }
      if (!key || !a.attackerTag) { skipped++; continue; }
      // Browser capital rows encode the target as "<oppTag>:<districtId>".
      let oppTag = null;
      let districtId = null;
      const m = String(a.defenderTag || '').match(/^(#?[^:]*):(\d+)$/);
      if (m) { oppTag = m[1] || 'enemy'; districtId = Number(m[2]); }
      else { oppTag = 'enemy'; districtId = 0; }
      capitalRows.push({
        season_key: key,
        clan_tag: clanTag,
        opponent_clan_tag: oppTag,
        opponent_clan_name: null,
        attacker_tag: a.attackerTag,
        attacker_name: a.attackerName ?? null,
        district_id: districtId,
        district_name: a.defenderName ?? null,
        attack_number: a.attackOrder ?? 1,
        stars: a.stars ?? null,
        destruction_percentage: a.destructionPercent ?? null,
        data: {},
      });
    } else if (context === 'cwl') {
      // contextRef is "<season>:R<round>"; warTag when the browser knows it.
      const ref = String(a.contextRef || '');
      const rm = ref.match(/^(.*):R(\d+)$/);
      if (!rm || !a.attackerTag || !a.warTag) { skipped++; continue; }
      const season = rm[1];
      const roundNo = Number(rm[2]);
      let seasonKey = await findCwlSeasonKey(clanTag, season);
      if (!seasonKey) seasonKey = cwlSeasonKey(clanTag, season);
      cwlRows.push({
        season_key: seasonKey,
        war_tag: a.warTag,
        round_no: roundNo,
        clan_tag: clanTag,
        attacker_tag: a.attackerTag,
        attacker_name: a.attackerName ?? null,
        defender_tag: a.defenderTag != null ? String(a.defenderTag) : null,
        defender_name: a.defenderName ?? null,
        stars: a.stars ?? null,
        destruction_percentage: a.destructionPercent ?? null,
        order_no: a.attackOrder,
        data: {},
      });
    } else {
      skipped++;
    }
  }

  if (warRows.length) {
    await upsert('war_attacks', warRows, { onConflict: 'war_key,clan_tag,attacker_tag,order_no' });
  }
  if (capitalRows.length) {
    await upsert('capital_attacks', capitalRows, {
      onConflict: 'season_key,attacker_tag,district_id,attack_number,opponent_clan_tag',
    });
  }
  if (cwlRows.length) {
    await upsert('cwl_attacks', cwlRows, { onConflict: 'war_tag,clan_tag,attacker_tag,order_no' });
  }

  return { war: warRows.length, capital: capitalRows.length, cwl: cwlRows.length, skipped };
}

module.exports = { getAttackLog, saveAttacks };
