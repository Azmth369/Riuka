// Formats a structured query result as plain deterministic text. This is the
// final fallback when every AI provider fails — the user still gets a correct,
// if plain, answer.

const { runDeterministicQuery } = require('./queryRouter');

const IST_TZ = 'Asia/Kolkata';

function formatIST(value) {
  if (!value) return 'unknown';
  const d = new Date(value);
  if (isNaN(d)) return 'unknown';
  return d.toLocaleString('en-GB', {
    timeZone: IST_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST';
}

function metricLabel(metric) {
  if (metric === 'donations') return 'donations';
  if (metric === 'trophies') return 'trophies';
  return metric;
}

function formatRows(rows, query) {
  if (!rows || rows.length === 0) return 'No matching records were found.';
  if (query === 'clan_identity') {
    const r = rows[0];
    return `${r.name ?? 'Unknown clan'} (${r.tag ?? 'unknown tag'}) — ${r.members ?? 0} members.`;
  }
  if (query === 'opponent') {
    const r = rows[0];
    return `You are currently at war with ${r.name ?? 'an unknown clan'}${r.tag ? ` (${r.tag})` : ''}.`;
  }
  if (query === 'state') return `The current war state is ${rows[0].state}.`;
  if (query === 'timing') {
    const r = rows[0];
    return `War start: ${formatIST(r.start_time)}\nWar end: ${formatIST(r.end_time)}\nState: ${r.state}.`;
  }
  if (query === 'members') {
    return rows.map(r => `${r.name}${r.tag ? ` (${r.tag})` : ''} — ${r.attacks_used}/${r.attacks_available} attacks used`).join('\n');
  }
  if (query === 'statistics') {
    const r = rows[0];
    const lines = [`Team size: ${r.team_size}`, `Attacks used: ${r.attacks_used}/${r.attacks_available}`, `Attacks remaining: ${r.attacks_remaining}`, `Stars earned: ${r.stars_earned}`];
    if (typeof r.destruction_percentage_sum === 'number') lines.push(`Destruction total: ${r.destruction_percentage_sum.toFixed(2)}%`);
    if (r.opponent && r.opponent.name) lines.push(`Opponent: ${r.opponent.name} — ${r.opponent.stars ?? 0} stars.`);
    return lines.join('\n');
  }
  if (query === 'role') return rows.map(r => r.name).join('\n');
  if (query === 'attack_usage') {
    return rows.map(r => `${r.name} — ${r.attacks_used}/${r.attacks_available} attacks used (${r.attacks_remaining} remaining)`).join('\n');
  }
  return rows.map(r => `${r.name} — ${r.value} ${metricLabel(r.metric)}`).join('\n');
}

async function answerDeterministically(question, clanTag) {
  const result = await runDeterministicQuery(question, clanTag);
  if (!result) return null;
  const lines = [];
  if (result.event && result.event.opponent && result.query !== 'opponent') {
    lines.push(`War/event vs ${result.event.opponent} (${result.event.state}).`);
  }
  if (result.query === 'role') lines.push(`${result.role}: ${result.result_count} member${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query === 'attack_usage') lines.push(`${result.result_count} matching player${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query === 'members') lines.push(`${result.result_count} war member${result.result_count === 1 ? '' : 's'}.`);
  else if (result.query && !['opponent', 'state', 'timing', 'statistics', 'clan_identity'].includes(result.query)) {
    lines.push(`${result.result_count} matching result${result.result_count === 1 ? '' : 's'}.`);
  }
  if (result.note) lines.push(result.note);
  const body = formatRows(result.result ?? [], result.query);
  return {
    text: `${lines.join('\n')}${lines.length ? '\n' : ''}${body}`.trim(),
    query: result,
  };
}

module.exports = { answerDeterministically, formatIST };
