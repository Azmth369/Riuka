// Server-side AI context builder. Replaces the browser-side buildContext():
// the frontend now just POSTs a question to /ask and the server decides what
// data the model needs.
//
// Two-string pattern (from ponyo): this module sees ONLY the current question.
// Conversation history is merged into the provider call solely to resolve
// pronouns like "they"/"that war" — an old mention of "capital raid" must
// never hijack the routing of a new war question.

const retrieval = require('./retrieval');
const liveData = require('./liveData');
const { runDeterministicQuery } = require('./queryRouter');
const { stripNegatedDatasets } = require('./queryEngine');
const { epochOf, cocStamp } = require('./transform');
const notes = require('./notes');
const analytics = require('./analytics');

const MONTHS = /january|february|march|april|may|june|july|august|september|october|november|december|month|year|trend|history|improv|declin/i;
const WAR = /war|attack|defen|star|opponent|miss|hit|battle|participat/i;
const CAPITAL = /capital|raid/i;
const CWL = /cwl|clan war league|league day/i;
const MEMBER = /member|player|donat|troph|town hall|inactive|role|elder|elders|co-?leader|leader|lowest|highest|who|tag|participat|clan|quiet|gone|join|left/i;
const ROLE_NAMES = { leader: 'Leader', coleader: 'Co-Leader', admin: 'Elder', member: 'Member' };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function monthKeyOf(value) {
  const ms = epochOf(value);
  if (ms == null) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabelOf(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function classify(question) {
  const q = stripNegatedDatasets(question.toLowerCase());
  const capital = CAPITAL.test(q);
  const cwl = CWL.test(q);
  return {
    member: MEMBER.test(q),
    war: WAR.test(q) && !capital && !cwl,
    capital,
    cwl,
    history: MONTHS.test(q),
  };
}

function extractPlayerName(question, players) {
  const normalized = question.toLowerCase();
  return [...players]
    .sort((a, b) => b.name.length - a.name.length)
    .find(p => normalized.includes(String(p.name).toLowerCase())) ?? null;
}

function normalizeRole(role) {
  const raw = String(role ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  return ROLE_NAMES[raw] || String(role ?? 'Unknown');
}

function rollupWars(wars) {
  const byMonth = new Map();
  for (const w of wars) {
    const key = monthKeyOf(w.end_time);
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, { month: key, totalWars: 0, wins: 0, losses: 0, ties: 0, ourStarsSum: 0, theirStarsSum: 0 });
    const agg = byMonth.get(key);
    agg.totalWars++;
    if (w.result === 'win') agg.wins++;
    else if (w.result === 'lose') agg.losses++;
    else if (w.result === 'tie') agg.ties++;
    agg.ourStarsSum += w.our_stars || 0;
    agg.theirStarsSum += w.their_stars || 0;
  }
  return [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabelOf(agg.month), totalWars: agg.totalWars,
      wins: agg.wins, losses: agg.losses, ties: agg.ties,
      avgOurStars: agg.totalWars ? +(agg.ourStarsSum / agg.totalWars).toFixed(2) : 0,
      avgTheirStars: agg.totalWars ? +(agg.theirStarsSum / agg.totalWars).toFixed(2) : 0,
    }));
}

function rollupCapital(raids) {
  const byMonth = new Map();
  for (const r of raids) {
    const key = monthKeyOf(r.start_time);
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, { month: key, weekends: 0, loot: 0, attacks: 0, raids: 0 });
    const agg = byMonth.get(key);
    agg.weekends++;
    agg.loot += r.total_loot || 0;
    agg.attacks += r.total_attacks || 0;
    agg.raids += r.raids_completed || 0;
  }
  return [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabelOf(agg.month), weekends: agg.weekends,
      totalLoot: agg.loot, totalAttacks: agg.attacks, raidsCompleted: agg.raids,
    }));
}

// ---------------------------------------------------------------------------
// Tools — callable by the model, executed server-side against the full archive.
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_war_history',
      description: 'Search the complete archived war history by opponent name substring and/or calendar month. Returns every matching war with date, opponent, team size, stars and result.',
      parameters: {
        type: 'object',
        properties: {
          opponentContains: { type: 'string', description: 'Case-insensitive substring of the opponent clan name' },
          year: { type: 'integer', description: 'Four-digit year, e.g. 2026' },
          month: { type: 'integer', description: 'Month number 1-12' },
          limit: { type: 'integer', description: 'Max wars to return (default 10, max 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_capital_raids',
      description: 'Search the complete archived Clan Capital raid history by calendar month. Returns matching raid weekends with loot, raids completed and attacks used.',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'integer' },
          month: { type: 'integer', description: 'Month number 1-12' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Full-text search the clan notebooks (personal notes). Returns matching notes with their notebook and date.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search text' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_attack_details',
      description: 'Get the individual attacks for one specific war or raid weekend. Use after identifying the event (e.g. from search_war_history) — pass its context ("war" or "capital") and context_ref (war_key / season_key from the search result).',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', enum: ['war', 'capital', 'cwl'] },
          contextRef: { type: 'string', description: 'The context_ref value from a prior search result' },
        },
        required: ['context', 'contextRef'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_attack_log',
      description: 'Search EVERY individual attack ever recorded, by attacker or defender name substring and optional context. Use for "has X ever attacked Y" or "who attacked Z" questions across the whole archive, not one specific war.',
      parameters: {
        type: 'object',
        properties: {
          attackerContains: { type: 'string' },
          defenderContains: { type: 'string' },
          context: { type: 'string', enum: ['war', 'capital', 'cwl'] },
          limit: { type: 'integer' },
        },
      },
    },
  },
];

function makeToolHandlers(clanTag) {
  return {
    async search_war_history({ opponentContains, year, month, limit } = {}) {
      const rows = await retrieval.searchWars(clanTag, {
        opponentContains: opponentContains || '',
        year: year ?? null,
        month: month ?? null,
        limit: limit || 10,
      });
      return {
        count: rows.length,
        wars: rows.map(w => ({
          context: 'war', context_ref: w.war_key,
          end_time: w.end_time, opponent: w.opponent_name,
          team_size: w.team_size, result: w.result,
          our_stars: w.our_stars, their_stars: w.their_stars,
        })),
      };
    },
    async search_capital_raids({ year, month, limit } = {}) {
      const rows = await retrieval.searchCapitalRaids(clanTag, {
        year: year ?? null, month: month ?? null, limit: limit || 10,
      });
      return {
        count: rows.length,
        raids: rows.map(r => ({
          context: 'capital', context_ref: r.start_time,
          start_time: r.start_time, total_loot: r.total_loot,
          raids_completed: r.raids_completed, total_attacks: r.total_attacks,
          participants: (r.members || []).length,
        })),
      };
    },
    async search_notes({ keyword } = {}) {
      const rows = await notes.searchNotes(clanTag, keyword || '');
      return {
        count: rows.length,
        notes: rows.slice(0, 20).map(n => ({
          notebook: n.notebook, content: n.content, created_at: n.created_at,
        })),
      };
    },
    async get_attack_details({ context, contextRef } = {}) {
      if (!context || !contextRef) return { error: 'context and contextRef are required' };
      const rows = await retrieval.searchAttackLog(clanTag, { context, contextRef, limit: 500 });
      return {
        count: rows.length,
        attacks: rows.map(a => ({
          attacker: a.attacker_name, defender: a.defender_name,
          stars: a.stars, destruction_percent: a.destruction_percent,
          attack_order: a.attack_order,
        })),
      };
    },
    async search_attack_log({ attackerContains, defenderContains, context, limit } = {}) {
      const rows = await retrieval.searchAttackLog(clanTag, {
        attackerContains: attackerContains || undefined,
        defenderContains: defenderContains || undefined,
        context: context || undefined,
        limit: limit || 50,
      });
      return {
        count: rows.length,
        attacks: rows.slice(0, 50).map(a => ({
          context: a.context, attacker: a.attacker_name, defender: a.defender_name,
          stars: a.stars, destruction_percent: a.destruction_percent,
          recorded_at: a.recorded_at,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The context builder.
// ---------------------------------------------------------------------------

async function buildContext(question, clanTag) {
  const kind = classify(question);
  const context = { retrieval: kind };
  const wantPlayers = kind.member || kind.history;

  let players = [];
  if (wantPlayers) {
    players = (await retrieval.getPlayers(clanTag, { limit: 100 })).map(p => ({
      ...p,
      role_label: normalizeRole(p.role),
    }));
    context.players = players.map(p => ({
      name: p.name, tag: p.tag, role: p.role, role_label: p.role_label,
      town_hall_level: p.town_hall_level, trophies: p.trophies,
      donations: p.donations, donations_received: p.donations_received,
      last_active: p.last_active,
    }));
  }

  if (kind.member && !kind.war && !kind.cwl && !kind.capital) {
    const clanRow = await retrieval.getClanInfo(clanTag);
    // "Who's gone quiet" — roster ranked by last tracked activity, from the
    // snapshot diffs (a member counts as active when any tracked stat changed).
    if (players.length) {
      context.quiet_members = await analytics.quietMembers(clanTag, players);
    }
    context.clan = clanRow ? {
      name: clanRow.data?.name ?? null,
      tag: clanRow.tag,
      members: clanRow.data?.members ?? null,
    } : null;
  }

  if (kind.war) {
    const live = await liveData.getLiveWar(clanTag);
    let warKey = null;
    if (live) {
      context.current_war = {
        source: 'live',
        state: live.state,
        start_time: live.start_time,
        end_time: live.end_time,
        team_size: live.team_size,
        us: live.us,
        opponent: live.opponent,
      };
      context.current_war_members = live.our_members.map(m => ({
        ...m,
        missed_attacks: Math.max(Number(m.attacks_available ?? 0) - Number(m.attacks_used ?? 0), 0),
      }));
    } else {
      const row = await retrieval.getCurrentWarRow(clanTag);
      if (row) {
        warKey = row.war_key;
        const members = await retrieval.getWarMembers(warKey);
        context.current_war = {
          source: 'db',
          state: row.state,
          start_time: row.start_time,
          end_time: row.end_time,
          us: { stars: row.data?.ourStars, destruction_percentage: row.data?.ourDestruction },
          opponent: { name: row.data?.opponentName, tag: row.data?.opponentTag, stars: row.data?.theirStars },
        };
        context.current_war_members = members.map(m => ({
          ...m,
          missed_attacks: Math.max(Number(m.attacks_available ?? 0) - Number(m.attacks_used ?? 0), 0),
        }));
      }
    }
    if (warKey) {
      const attacks = await retrieval.getWarAttacks(warKey, { limit: 200 });
      context.current_war_attacks = attacks.map(a => ({
        attacker: a.attacker_name, defender: a.defender_name,
        stars: a.stars, destruction_percent: a.destruction_percentage,
        order_no: a.order_no,
      }));
    }
    const wars = await retrieval.getWarHistory(clanTag, { limit: 100 });
    context.recent_wars = wars.slice(0, 25);
    context.war_monthly_rollups = rollupWars(wars);
    context.war_total_count = wars.length;
  }

  if (kind.capital) {
    const live = await liveData.getLiveCapital(clanTag);
    const season = await retrieval.getLatestCapitalSeason(clanTag);
    if (live || season) {
      context.capital_current_season = {
        state: live ? live.state : (season && season.start_time && monthKeyOf(season.start_time) === monthKeyOf(new Date().toISOString()) ? 'recent' : 'synced'),
        start_time: live ? live.start_time : season.start_time,
        end_time: live ? live.end_time : null,
        total_loot: live ? live.total_loot : season.total_loot,
        raids_completed: live ? live.raids_completed : season.raids_completed,
        total_attacks: live ? live.total_attacks : season.total_attacks,
        participants: live
          ? live.participants.map(p => ({ name: p.player_name, attacks_used: p.attacks_used, attacks_available: p.attacks_available, total_loot: p.total_loot }))
          : (season.members || []).map(m => ({ name: m.name, attacks_used: m.attacksUsed, attacks_available: m.attackLimit, total_loot: m.loot })),
        // The CoC API only lists members who already attacked. Absentees are
        // the roster members when the weekend began who have not attacked.
        absentees: (season && season.absentees) || [],
      };
    }
    const raids = await retrieval.getCapitalHistory(clanTag, { limit: 100 });
    context.recent_capital_raids = raids.slice(0, 25);
    context.capital_monthly_rollups = rollupCapital(raids);
    context.capital_total_count = raids.length;

    // Player capital leaderboard from the attack archive.
    const attacks = await retrieval.getCapitalAttacks({ limit: 1000 });
    const byPlayer = new Map();
    for (const a of attacks) {
      if (!byPlayer.has(a.attacker_tag)) {
        byPlayer.set(a.attacker_tag, { name: a.attacker_name, tag: a.attacker_tag, capital_gold: 0, attacks: 0, stars: 0 });
      }
      const p = byPlayer.get(a.attacker_tag);
      p.attacks++;
      p.stars += a.stars || 0;
      p.capital_gold += (a.data && a.data.loot) || 0;
    }
    context.capital_player_rankings = {
      by_stars: [...byPlayer.values()].sort((a, b) => b.stars - a.stars || b.attacks - a.attacks).slice(0, 15),
      by_attacks: [...byPlayer.values()].sort((a, b) => b.attacks - a.attacks).slice(0, 15),
      note: 'Computed from the synced capital attack archive.',
    };
  }

  if (kind.cwl) {
    const history = await retrieval.getCwlHistory(clanTag);
    const latest = history[history.length - 1];
    if (latest) {
      const lastRound = latest.rounds[latest.rounds.length - 1];
      context.cwl_current = {
        season: latest.season,
        rounds: latest.rounds.length,
        latest_round: lastRound ? {
          round: lastRound.round,
          state: lastRound.state,
          opponent: lastRound.opponent && lastRound.opponent.name,
          us: lastRound.us,
        } : null,
      };
    }
    context.cwl_history = history.map(s => ({
      season: s.season,
      rounds: (s.rounds || []).map(r => ({
        round: r.round, state: r.state,
        opponent: r.opponent && r.opponent.name,
        us_stars: r.us && r.us.stars, opponent_stars: r.opponent && r.opponent.stars,
      })),
    }));
  }

  if (kind.history && players.length) {
    const player = extractPlayerName(question, players);
    if (player) {
      context.player_snapshots = (await retrieval.getSnapshots(player.tag, { limit: 200 })).map(s => ({
        captured_at: s.captured_at,
        ...(s.data || {}),
      }));
      // Donation/trophy trend over the snapshot window.
      context.player_trends = await analytics.memberTrends(player.tag);
      // Cross-event participation: wars on the roster (including zero-attack
      // wars), capital-raid absentees, all from the normalized tables.
      context.player_participation = await analytics.participationHistory(clanTag, player.tag);
      context.capital_absentee_history = await analytics.absenteesHistory(clanTag, { limit: 12 });
      const warLog = await retrieval.searchAttackLog(clanTag, { limit: 500 });
      context.player_historical_attacks = warLog
        .filter(a => a.attacker_tag === player.tag)
        .slice(0, 100)
        .map(a => ({ context: a.context, stars: a.stars, destruction_percent: a.destruction_percent, recorded_at: a.recorded_at }));
    }
  }

  // The structured query result (Supabase + live CoC API) is authoritative
  // for the underlying filter, count, ranking or ordering.
  try {
    context.structured_query = await runDeterministicQuery(question, clanTag);
  } catch (error) {
    console.error('[chat-context] structured query failed; continuing without it:', error.message);
    context.structured_query = null;
  }

  context.meta = {
    generated_at: new Date().toISOString(),
    clan_tag: clanTag,
    note: 'Timestamps are ISO instants; attack_time/observed_at are source times. structured_query (when present) is AUTHORITATIVE for counts/filters/rankings.',
  };

  return context;
}

module.exports = { buildContext, classify, TOOL_DEFINITIONS, makeToolHandlers, rollupWars, rollupCapital };
