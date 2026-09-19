// Database-backed deterministic query router. Turns a query plan into real
// rows from the Riuka schema and returns a structured result. Filtering is
// delegated to queryEngine.applyAttackUsageFilters so the pure intent
// executor and this router can never disagree.
//
// War questions prefer the live CoC API snapshot (state, time left, live
// scores, fresh attack usage); the Supabase sync (up to a poll interval old)
// is the fallback. Capital and CWL questions are scoped to the latest synced
// season/day so participants from different weekends are never mixed.

const retrieval = require('./retrieval');
const liveData = require('./liveData');
const cocApi = require('./cocApi');
const {
  buildQueryPlan, deterministicWarMembers, deterministicMemberMetric,
  deterministicRole, applyAttackUsageFilters,
} = require('./queryEngine');
const { epochOf } = require('./transform');

function metricRows(result) {
  return result.rows.map(p => ({
    name: p.name, tag: p.tag, value: Number(p[result.plan.metric] ?? 0), metric: result.plan.metric,
  }));
}

const roleRows = result => result.rows.map(r => ({ name: r.name, tag: r.tag }));

function attackUsageResult(plan, rows) {
  const filtered = applyAttackUsageFilters(rows, plan);
  return {
    intent: 'structured_clan_query',
    scope: plan.scope,
    query: 'attack_usage',
    filter: {
      unused: plan.unused,
      attacks_used: plan.attacks_used,
      attacks_used_min: plan.attacks_used_min ?? null,
      attacks_remaining: plan.attacks_remaining,
    },
    result_count: filtered.length,
    result: filtered.map(r => ({
      name: r.player_name,
      tag: r.player_tag,
      map_position: r.map_position,
      attacks_used: Number(r.attacks_used ?? 0),
      attacks_available: Number(r.attacks_available ?? 0),
      attacks_remaining: Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0),
      stars_earned: Number(r.stars_earned ?? 0),
      destruction_percentage: Number(r.destruction_percentage ?? 0),
    })),
  };
}

function currentWarStatistics(members, live = null) {
  const stats = {
    team_size: members.length,
    attacks_available: members.reduce((s, r) => s + Number(r.attacks_available ?? 0), 0),
    attacks_used: members.reduce((s, r) => s + Number(r.attacks_used ?? 0), 0),
    attacks_remaining: members.reduce((s, r) => s + Math.max(Number(r.attacks_available ?? 0) - Number(r.attacks_used ?? 0), 0), 0),
    stars_earned: members.reduce((s, r) => s + Number(r.stars_earned ?? 0), 0),
    destruction_percentage_sum: members.reduce((s, r) => s + Number(r.destruction_percentage ?? 0), 0),
  };
  if (live && live.opponent) {
    stats.opponent = live.opponent;
    if (live.us) stats.us = live.us;
  }
  return stats;
}

async function runDeterministicQuery(question, clanTag) {
  if (!clanTag) return null;
  const plan = buildQueryPlan(question);

  if (plan.operation === 'clan_identity') {
    const clanRow = await retrieval.getClanInfo(clanTag);
    if (clanRow && clanRow.data) {
      return {
        intent: 'structured_query', scope: 'clan', query: 'clan_identity', field: plan.identity_field,
        result_count: 1,
        result: [{ name: clanRow.data.name ?? null, tag: clanRow.tag, members: clanRow.data.members ?? null }],
      };
    }
    try {
      const clan = await cocApi.getClan(clanTag);
      return {
        intent: 'structured_query', scope: 'clan', query: 'clan_identity', field: plan.identity_field,
        result_count: 1,
        result: [{ name: clan.name ?? null, tag: clan.tag, members: Number(clan.members ?? (clan.memberList || []).length) }],
      };
    } catch (e) {
      return null;
    }
  }

  if (plan.operation === 'member_metric') {
    const players = await retrieval.getPlayers(clanTag, { limit: 100 });
    const result = deterministicMemberMetric(question, players);
    if (!result) return null;
    let rows = metricRows(result);
    if (!plan.asks_count && plan.sort) rows = rows.slice(0, 1);
    return { intent: 'structured_query', scope: 'clan', query: plan.metric, sort: plan.sort, result_count: rows.length, result: rows };
  }

  if (plan.operation === 'role_members') {
    const players = await retrieval.getPlayers(clanTag, { limit: 100 });
    const result = deterministicRole(question, players);
    if (!result) return null;
    return { intent: 'structured_query', scope: 'clan', query: 'role', role: plan.role, result_count: result.rows.length, result: roleRows(result) };
  }

  if (plan.scope === 'war') {
    // Live CoC API first: correct state, time left and fresh attack usage.
    const live = await liveData.getLiveWar(clanTag);
    const current = live || (async () => {
      const row = await retrieval.getCurrentWarRow(clanTag);
      if (!row) return null;
      const members = await retrieval.getWarMembers(row.war_key);
      return {
        source: 'db',
        war_key: row.war_key,
        state: row.state,
        start_time: row.start_time,
        end_time: row.end_time,
        opponent: { name: (row.data || {}).opponentName ?? null, tag: (row.data || {}).opponentTag ?? null },
        our_members: members,
      };
    })();
    const currentWar = await Promise.resolve(current);
    if (!currentWar) {
      return { intent: 'structured_query', scope: 'war', query: plan.operation, result_count: 0, result: [], note: 'No current normal clan war is available.' };
    }

    const event = {
      source: currentWar.source,
      state: currentWar.state,
      start_time: currentWar.start_time,
      end_time: currentWar.end_time,
      opponent: currentWar.opponent?.name ?? null,
      opponent_tag: currentWar.opponent?.tag ?? null,
    };

    if (plan.operation === 'opponent') {
      return {
        intent: 'structured_query', scope: 'war', query: 'opponent',
        result_count: currentWar.opponent?.name || currentWar.opponent?.tag ? 1 : 0,
        result: [{ name: currentWar.opponent?.name ?? null, tag: currentWar.opponent?.tag ?? null }],
        event,
      };
    }

    if (plan.operation === 'state') {
      const timeLeft = event.end_time ? new Date(event.end_time).getTime() - Date.now() : null;
      return {
        intent: 'structured_query', scope: 'war', query: 'state', result_count: 1,
        result: [{ state: event.state, time_left_ms: timeLeft, end_time: event.end_time }],
        event,
      };
    }

    if (plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'war', query: 'timing', result_count: 1,
        result: [{ start_time: event.start_time, end_time: event.end_time, state: event.state }],
        event,
      };
    }

    const members = currentWar.our_members || [];

    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'war', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_tag, map_position: r.map_position,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          stars_earned: Number(r.stars_earned ?? 0), destruction_percentage: Number(r.destruction_percentage ?? 0),
        })),
        event,
      };
    }

    if (plan.operation === 'statistics') {
      return {
        intent: 'structured_query', scope: 'war', query: 'statistics', result_count: 1,
        result: [currentWarStatistics(members, live)],
        event,
      };
    }

    if (plan.operation === 'member_attack_usage') {
      const result = deterministicWarMembers(question, members);
      if (!result) return null;
      return { ...attackUsageResult(result.plan, members), event };
    }
  }

  if (plan.scope === 'cwl') {
    const history = await retrieval.getCwlHistory(clanTag);
    const latest = history[history.length - 1];
    if (!latest || !latest.rounds || !latest.rounds.length) {
      return { intent: 'structured_query', scope: 'cwl', query: plan.operation, result_count: 0, result: [], note: 'No CWL data has been synced yet.' };
    }
    const round = latest.rounds[latest.rounds.length - 1];
    const members = (round.ourMembers || []).map(m => ({
      player_tag: null,
      player_name: m.name,
      map_position: m.mapPosition,
      attacks_available: 1,
      attacks_used: m.attacksUsed,
      stars_earned: m.starsEarned,
      destruction_percentage: 0,
    }));
    const event = {
      dataset: 'cwl',
      season: latest.season,
      cwl_round: round.round,
      opponent: (round.opponent && round.opponent.name) || null,
      state: round.state ?? null,
    };
    if (plan.operation === 'member_attack_usage') {
      return { ...attackUsageResult(plan, members), event };
    }
    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'cwl', query: 'members', result_count: members.length,
        result: members.map(r => ({ name: r.player_name, tag: r.player_tag, attacks_used: r.attacks_used, attacks_available: r.attacks_available, stars_earned: r.stars_earned })),
        event,
      };
    }
    if (plan.operation === 'opponent') {
      return { intent: 'structured_query', scope: 'cwl', query: 'opponent', result_count: event.opponent ? 1 : 0, result: [{ name: event.opponent }], event };
    }
    if (plan.operation === 'state' || plan.operation === 'timing') {
      return { intent: 'structured_query', scope: 'cwl', query: plan.operation, result_count: 1, result: [{ state: round.state ?? 'synced' }], event };
    }
  }

  if (plan.scope === 'capital') {
    const live = await liveData.getLiveCapital(clanTag);
    const season = await retrieval.getLatestCapitalSeason(clanTag);
    if (!season && !live) {
      return { intent: 'structured_query', scope: 'capital', query: plan.operation, result_count: 0, result: [], note: 'No capital raid data has been synced yet.' };
    }
    const members = live
      ? live.participants
      : (season.members || []).map(m => ({
        player_tag: m.tag, player_name: m.name,
        attacks_used: m.attacksUsed, attacks_available: m.attackLimit, total_loot: m.loot,
      }));
    const event = {
      dataset: 'capital',
      state: live ? live.state : 'synced',
      start_time: live ? live.start_time : season.start_time,
      end_time: live ? live.end_time : null,
      raids_completed: live ? live.raids_completed : season.raids_completed,
      total_attacks: live ? live.total_attacks : season.total_attacks,
      total_loot: live ? live.total_loot : season.total_loot,
    };
    if (plan.operation === 'member_attack_usage') {
      // The CoC API only lists capital members who already attacked, so
      // participant rows can never answer "who has not attacked". That
      // answer comes from the season's absentees: the clan roster when the
      // weekend began, minus everyone who has attacked.
      if (plan.unused) {
        const absentees = (season && season.absentees) || [];
        return {
          intent: 'structured_clan_query',
          scope: 'capital',
          query: 'attack_usage',
          filter: { unused: true, attacks_used: null, attacks_used_min: null, attacks_remaining: null },
          result_count: absentees.length,
          result: absentees.map(name => ({ name, attacks_used: 0, attacks_available: 0, attacks_remaining: 0 })),
          event,
          note: 'Members of the roster when the raid weekend began who have not used any attacks in this weekend.',
        };
      }
      return { ...attackUsageResult(plan, members), event };
    }
    if (plan.operation === 'members') {
      return {
        intent: 'structured_query', scope: 'capital', query: 'members', result_count: members.length,
        result: members.map(r => ({
          name: r.player_name, tag: r.player_tag,
          attacks_used: Number(r.attacks_used ?? 0), attacks_available: Number(r.attacks_available ?? 0),
          total_loot: Number(r.total_loot ?? 0),
        })),
        event,
      };
    }
    if (plan.operation === 'statistics') {
      return {
        intent: 'structured_query', scope: 'capital', query: 'statistics', result_count: 1,
        result: [{
          participants: members.length,
          attacks_used: members.reduce((s, r) => s + Number(r.attacks_used ?? 0), 0),
          attacks_available: members.reduce((s, r) => s + Number(r.attacks_available ?? 0), 0),
          total_loot: event.total_loot,
          raids_completed: event.raids_completed,
        }],
        event,
      };
    }
    if (plan.operation === 'state' || plan.operation === 'timing') {
      return {
        intent: 'structured_query', scope: 'capital', query: plan.operation, result_count: 1,
        result: [{ state: event.state, start_time: event.start_time, end_time: event.end_time }],
        event,
      };
    }
  }

  return null;
}

module.exports = { runDeterministicQuery };
