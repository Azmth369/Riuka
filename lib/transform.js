// Pure data transformations: CoC API payloads -> Riuka schema rows.
// No I/O in this module (no database, no network, no env reads) so it is
// fully unit-testable.
//
// CRITICAL RULE (the bug this project once had): every CoC timestamp
// ("20260915T195740.000Z") must be normalized to a canonical UTC ISO instant
// via cocStamp() BEFORE it is used in a key, a comparison, or a where-clause.
// PostgREST returns timestamptz as "2026-09-15T19:57:40+00:00" while the CoC
// API returns ".000Z" — string comparison made the same war/raid be saved as
// two (and sometimes three) separate events. Compare instants, never strings.

// CoC API timestamps look like 20260915T183000.000Z. Returns canonical
// "YYYY-MM-DDTHH:MM:SS.sssZ" or null. Also accepts normal ISO strings so any
// timestamp from any source can be pushed through this one normalizer.
function cocStamp(value) {
  if (value == null) return null;
  const raw = String(value);
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  let d;
  if (m) {
    d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  } else {
    d = new Date(raw);
  }
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Instant of any timestamp shape, or null.
function epochOf(value) {
  const iso = cocStamp(value);
  return iso == null ? null : new Date(iso).getTime();
}

// True when two timestamps denote the same instant, whatever their format.
function sameInstant(a, b) {
  const ta = epochOf(a);
  const tb = epochOf(b);
  return ta != null && tb != null && ta === tb;
}

// ---------------------------------------------------------------------------
// Event keys — instant-derived, stable across polls and formats.
// ---------------------------------------------------------------------------

function warKey(clanTag, endTime) {
  const iso = cocStamp(endTime);
  if (!iso) return null;
  return `CW:${clanTag}:${iso}`;
}

function capitalSeasonKey(clanTag, startTime) {
  const iso = cocStamp(startTime);
  if (!iso) return null;
  return `CR:${clanTag}:${iso}`;
}

function cwlSeasonKey(clanTag, season) {
  if (!season) return null;
  return `CWL:${clanTag}:${season}`;
}

// ---------------------------------------------------------------------------
// Regular clan war
// ---------------------------------------------------------------------------

function warResultFromSummary(war, own, opponent) {
  if (war && war.result) {
    if (war.result === 'lose') return 'lose';
    if (war.result === 'tie') return 'tie';
    if (war.result === 'win') return 'win';
  }
  if (!own || !opponent) return null;
  if (Number(own.stars ?? 0) !== Number(opponent.stars ?? 0)) {
    return Number(own.stars ?? 0) > Number(opponent.stars ?? 0) ? 'win' : 'lose';
  }
  if (Number(own.destructionPercentage ?? 0) !== Number(opponent.destructionPercentage ?? 0)) {
    return Number(own.destructionPercentage ?? 0) > Number(opponent.destructionPercentage ?? 0) ? 'win' : 'lose';
  }
  return 'tie';
}

// Wars belonging to the clan (not random matchmaking placeholders without an
// opponent name — warlog returns those for SCL-like entries).
function isRegularWarEntry(item) {
  return !!(item && item.opponent && item.opponent.name);
}

// Attacks are numbered in a stable order (attacker map position, then the
// order the API assigns) so re-syncing a war in progress produces the same
// (attacker, order_no) pairs and the unique constraint dedupes naturally.
function sortedWarAttacks(members = []) {
  const rows = [];
  for (const m of members) {
    for (const a of m.attacks ?? []) {
      rows.push({ member: m, attack: a, order: a.order ?? 0 });
    }
  }
  rows.sort((x, y) =>
    (x.member.mapPosition ?? 9999) - (y.member.mapPosition ?? 9999) ||
    x.order - y.order);
  return rows;
}

// Build the full row set for one normal war (from /currentwar or a warlog
// entry). warKeyValue must come from warKey() (or a previously-resolved
// existing key). Returns { war, members, attacks } with members including
// zero-attack players (the CoC API only lists attacks, not absence).
function warRows(war, clanTag, warKeyValue) {
  const own = war.clan && war.clan.tag === clanTag ? war.clan : null;
  const opponent = war.clan && war.clan.tag === clanTag ? war.opponent : null;
  if (!own) return { war: null, members: [], attacks: [] };

  const members = own.members ?? [];
  const theirNames = new Map((opponent?.members ?? []).map(m => [m.tag, m.name]));
  const ourNames = new Map(members.map(m => [m.tag, m.name]));
  const startIso = cocStamp(war.startTime);
  const endIso = cocStamp(war.endTime);

  const warRow = {
    clan_tag: clanTag,
    war_key: warKeyValue,
    state: war.state ?? null,
    start_time: startIso,
    end_time: endIso,
    data: {
      opponentName: opponent?.name ?? null,
      opponentTag: opponent?.tag ?? null,
      teamSize: war.teamSize ?? members.length ?? null,
      result: warResultFromSummary(war, own, opponent),
      ourStars: own.stars ?? null,
      theirStars: opponent?.stars ?? null,
      ourDestruction: own.destructionPercentage ?? null,
      theirDestruction: opponent?.destructionPercentage ?? null,
    },
  };

  const memberRows = members.map(m => ({
    war_key: warKeyValue,
    clan_tag: clanTag,
    player_tag: m.tag,
    player_name: m.name ?? null,
    map_position: m.mapPosition ?? null,
    attacks_available: 2, // regular wars give every roster member 2 attacks
    attacks_used: (m.attacks || []).length,
    stars_earned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0),
    destruction_percentage: (m.attacks || []).reduce((s, a) => s + (a.destructionPercentage || 0), 0),
    data: { townHallLevel: m.townHallLevel ?? null },
  }));

  // Attacks from BOTH sides (opponent attacks against us too), so the log is
  // complete. Opponent attackers carry clan_tag of the opponent for
  // uniqueness; attacker names come from their own roster.
  const attacks = [];
  const ordered = sortedWarAttacks(members);
  ordered.forEach((row, idx) => {
    attacks.push({
      war_key: warKeyValue,
      clan_tag: clanTag,
      attacker_tag: row.member.tag,
      attacker_name: row.member.name ?? null,
      defender_tag: row.attack.defenderTag ?? null,
      defender_name: theirNames.get(row.attack.defenderTag) ?? null,
      stars: row.attack.stars ?? null,
      destruction_percentage: row.attack.destructionPercentage ?? null,
      order_no: idx + 1,
      attack_time: cocStamp(row.attack.createdDate) ?? null,
      data: {},
    });
  });
  if (opponent?.members) {
    const oppOrdered = sortedWarAttacks(opponent.members);
    oppOrdered.forEach((row, idx) => {
      attacks.push({
        war_key: warKeyValue,
        clan_tag: opponent.tag,
        attacker_tag: row.member.tag,
        attacker_name: row.member.name ?? null,
        defender_tag: row.attack.defenderTag ?? null,
        defender_name: ourNames.get(row.attack.defenderTag) ?? null,
        stars: row.attack.stars ?? null,
        destruction_percentage: row.attack.destructionPercentage ?? null,
        order_no: idx + 1,
        attack_time: cocStamp(row.attack.createdDate) ?? null,
        data: {},
      });
    });
  }

  return { war: warRow, members: memberRows, attacks };
}

// ---------------------------------------------------------------------------
// Clan Capital raid
// ---------------------------------------------------------------------------

// Members mapped to the dashboard's long-standing shape.
function mapCapitalMembers(rawMembers = []) {
  return (rawMembers || []).map(m => ({
    tag: m.tag,
    name: m.name,
    attacksUsed: m.attacks,
    attackLimit: (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    loot: m.capitalResourcesLooted,
  }));
}

// One raid season row. `rosterTags` = the clan roster (tags + names) at the
// time of the sync — used to compute absentees, because the CoC API only
// lists members who already attacked.
function capitalRows(season, clanTag, seasonKeyValue, roster = []) {
  const startIso = cocStamp(season.startTime);
  if (!startIso) return null;
  const members = mapCapitalMembers(season.members);
  const attackerTags = new Set(members.map(m => m.tag).filter(Boolean));
  const absentees = (roster || [])
    .filter(p => p.tag && !attackerTags.has(p.tag))
    .map(p => p.name);
  return {
    clan_tag: clanTag,
    season_key: seasonKeyValue,
    data: {
      startTime: season.startTime,
      endTime: season.endTime ?? null,
      state: season.state ?? null,
      capitalTotalLoot: season.capitalTotalLoot ?? 0,
      raidsCompleted: season.raidsCompleted ?? 0,
      totalAttacks: season.totalAttacks ?? 0,
      enemyDistrictsDestroyed: season.enemyDistrictsDestroyed ?? 0,
      offensiveReward: season.offensiveReward ?? 0,
      defensiveReward: season.defensiveReward ?? 0,
      members,
      absentees,
    },
  };
}

// Extract individual capital attacks from a raid season's attackLog.
// attack_number is per (attacker, opponent, district) in encounter order,
// which keeps the unique constraint stable across re-polls.
function capitalAttackRows(season, clanTag, seasonKeyValue) {
  const out = [];
  if (!season || !seasonKeyValue) return out;
  const counters = new Map(); // `${attackerTag}|${oppTag}|${districtId}` -> n
  (season.attackLog || []).forEach(enemy => {
    (enemy.districts || []).forEach(d => {
      (d.attacks || []).forEach(a => {
        const oppTag = enemy.defender?.tag || 'enemy';
        const ck = `${a.attacker?.tag}|${oppTag}|${d.id}`;
        const n = (counters.get(ck) || 0) + 1;
        counters.set(ck, n);
        out.push({
          season_key: seasonKeyValue,
          clan_tag: clanTag,
          opponent_clan_tag: oppTag,
          opponent_clan_name: enemy.defender?.name ?? null,
          attacker_tag: a.attacker?.tag,
          attacker_name: a.attacker?.name ?? null,
          district_id: d.id ?? null,
          district_name: d.name ?? null,
          attack_number: n,
          stars: a.stars ?? null,
          destruction_percentage: a.destructionPercent ?? null,
          duration_seconds: null,
          attack_time: cocStamp(a.attackTime) ?? null,
          data: {},
        });
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// CWL
// ---------------------------------------------------------------------------

// One CWL round, mapped to the shape the dashboard expects (us/opponent
// summaries + our member usage) plus the raw war payload for attack
// extraction on the server side.
function cwlRoundRow(war, roundNo, seasonKeyValue, clanTag) {
  const own = war.clan && war.clan.tag === clanTag ? war.clan : war.opponent;
  const them = war.clan && war.clan.tag === clanTag ? war.opponent : war.clan;
  if (!own) return null;
  const members = own.members || [];
  return {
    clan_tag: clanTag,
    season_key: seasonKeyValue,
    round_no: roundNo,
    opponent_tag: them?.tag ?? null,
    opponent_name: them?.name ?? null,
    state: war.state ?? null,
    war_tag: war.tag ?? null,
    data: {
      teamSize: war.teamSize ?? null,
      us: {
        name: own.name,
        stars: own.stars ?? 0,
        destruction: own.destructionPercentage ?? 0,
        attacks: own.attacks ?? 0,
      },
      opponent: {
        name: them?.name ?? null,
        stars: them?.stars ?? 0,
        destruction: them?.destructionPercentage ?? 0,
      },
      ourMembers: members.map(m => ({
        name: m.name,
        mapPosition: m.mapPosition,
        townhallLevel: m.townhallLevel,
        attacksUsed: (m.attacks || []).length,
        starsEarned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0),
      })),
    },
  };
}

// Attacks for one CWL war. CWL gives each roster member 1 attack per day.
function cwlAttackRows(war, roundNo, seasonKeyValue, clanTag) {
  const own = war.clan && war.clan.tag === clanTag ? war.clan : war.opponent;
  const them = war.clan && war.clan.tag === clanTag ? war.opponent : war.clan;
  if (!own || !war.tag) return [];
  const theirNames = new Map((them?.members || []).map(m => [m.tag, m.name]));
  const out = [];
  sortedWarAttacks(own.members || []).forEach((row, idx) => {
    out.push({
      season_key: seasonKeyValue,
      war_tag: war.tag,
      round_no: roundNo,
      clan_tag: clanTag,
      attacker_tag: row.member.tag,
      attacker_name: row.member.name ?? null,
      defender_tag: row.attack.defenderTag ?? null,
      defender_name: theirNames.get(row.attack.defenderTag) ?? null,
      stars: row.attack.stars ?? null,
      destruction_percentage: row.attack.destructionPercentage ?? null,
      order_no: idx + 1,
      attack_time: cocStamp(row.attack.createdDate) ?? null,
      data: {},
    });
  });
  return out;
}

module.exports = {
  cocStamp,
  epochOf,
  sameInstant,
  warKey,
  capitalSeasonKey,
  cwlSeasonKey,
  warResultFromSummary,
  isRegularWarEntry,
  sortedWarAttacks,
  warRows,
  mapCapitalMembers,
  capitalRows,
  capitalAttackRows,
  cwlRoundRow,
  cwlAttackRows,
};
