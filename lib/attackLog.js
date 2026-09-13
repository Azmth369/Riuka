const { supabase } = require('./supabaseClient');

// One row per individual attack (war, CWL round, or capital raid hit).
// De-duplication happens via the unique constraint on
// (clan_tag, context, context_ref, attacker_tag, defender_tag, attack_order) —
// see the accompanying SQL. We always upsert with ignoreDuplicates, so
// polling the same live war/raid repeatedly just silently skips attacks
// already saved, and only genuinely new ones get inserted.

async function getAttackLog(clanTag, context, contextRef) {
  if (!supabase) return [];
  let query = supabase
    .from('attack_log')
    .select('context, context_ref, attacker_tag, attacker_name, defender_tag, defender_name, stars, destruction_percent, attack_order, recorded_at')
    .eq('clan_tag', clanTag)
    .order('recorded_at', { ascending: false })
    .limit(500);
  if (context) query = query.eq('context', context);
  if (contextRef) query = query.eq('context_ref', contextRef);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveAttacks(clanTag, attacks) {
  if (!supabase) return null;
  if (!attacks || attacks.length === 0) return [];
  const rows = attacks.map(a => ({
    clan_tag: clanTag,
    context: a.context,
    context_ref: String(a.contextRef),
    attacker_tag: a.attackerTag || null,
    attacker_name: a.attackerName || null,
    defender_tag: a.defenderTag != null ? String(a.defenderTag) : null,
    defender_name: a.defenderName || null,
    stars: a.stars ?? null,
    destruction_percent: a.destructionPercent ?? null,
    attack_order: a.attackOrder ?? null,
  }));
  const { data, error } = await supabase
    .from('attack_log')
    .upsert(rows, {
      onConflict: 'clan_tag,context,context_ref,attacker_tag,defender_tag,attack_order',
      ignoreDuplicates: true,
    })
    .select();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getAttackLog, saveAttacks };
