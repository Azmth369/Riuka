const { supabase } = require('./supabaseClient');

async function getCwlHistory(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('cwl_seasons')
    .select('season, rounds, saved_at')
    .eq('clan_tag', clanTag)
    .order('season', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function saveCwlSeason(clanTag, season, rounds) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cwl_seasons')
    .upsert(
      { clan_tag: clanTag, season, rounds, updated_at: new Date().toISOString() },
      { onConflict: 'clan_tag,season' }
    )
    .select();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getCwlHistory, saveCwlSeason };
