const { supabase } = require('./supabaseClient');

async function getNotes(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('personal_notes')
    .select('id, content, created_at')
    .eq('clan_tag', clanTag)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function addNote(clanTag, content) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('personal_notes')
    .insert({ clan_tag: clanTag, content })
    .select();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteNote(id) {
  if (!supabase) return null;
  const { error } = await supabase
    .from('personal_notes')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

module.exports = { getNotes, addNote, deleteNote };
