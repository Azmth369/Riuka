// /notes + /notebooks endpoint backend — Riuka-only feature (no ponyo
// counterpart). Real Postgres full-text search via the generated
// content_tsv column + GIN index (see migration 0002).

const { supabase } = require('./db');

async function getNotes(clanTag, notebook) {
  if (!supabase) return [];
  let query = supabase
    .from('personal_notes')
    .select('id, content, created_at, notebook')
    .eq('clan_tag', clanTag);
  if (notebook) query = query.eq('notebook', notebook);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function searchNotes(clanTag, searchQuery, notebook) {
  if (!supabase) return [];
  let query = supabase
    .from('personal_notes')
    .select('id, content, created_at, notebook')
    .eq('clan_tag', clanTag)
    .textSearch('content_tsv', searchQuery, { type: 'websearch', config: 'english' });
  if (notebook) query = query.eq('notebook', notebook);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function listNotebooks(clanTag) {
  if (!supabase) return ['General'];
  const { data, error } = await supabase
    .from('personal_notes')
    .select('notebook')
    .eq('clan_tag', clanTag);
  if (error) throw new Error(error.message);
  const names = new Set((data || []).map(r => r.notebook).filter(Boolean));
  names.add('General');
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

async function addNote(clanTag, content, notebook) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('personal_notes')
    .insert({ clan_tag: clanTag, content, notebook: notebook || 'General' })
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

module.exports = { getNotes, addNote, deleteNote, searchNotes, listNotebooks };
