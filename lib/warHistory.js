const { supabase } = require('./supabaseClient');

async function getWarHistory(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('clan_war_history')
    .select('end_time, opponent_name, team_size, result, our_stars, their_stars, our_destruction, their_destruction, saved_at')
    .eq('clan_tag', clanTag)
    .order('end_time', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveWar(clanTag, war) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('clan_war_history')
    .upsert(
      {
        clan_tag: clanTag,
        end_time: war.endTime,
        opponent_name: war.opponentName,
        team_size: war.teamSize,
        result: war.result,
        our_stars: war.ourStars,
        their_stars: war.theirStars,
        our_destruction: war.ourDestruction,
        their_destruction: war.theirDestruction,
      },
      { onConflict: 'clan_tag,end_time' }
    )
    .select();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getWarHistory, saveWar };
