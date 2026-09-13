const { supabase } = require('./supabaseClient');

async function getCapitalHistory(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('capital_raid_history')
    .select('start_time, total_loot, raids_completed, total_attacks, members, saved_at')
    .eq('clan_tag', clanTag)
    .order('start_time', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveCapitalSeason(clanTag, season) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('capital_raid_history')
    .upsert(
      {
        clan_tag: clanTag,
        start_time: season.startTime,
        total_loot: season.totalLoot,
        raids_completed: season.raidsCompleted,
        total_attacks: season.totalAttacks,
        members: season.members || null,
      },
      { onConflict: 'clan_tag,start_time' }
    )
    .select();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getCapitalHistory, saveCapitalSeason };
