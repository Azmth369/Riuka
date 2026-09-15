const { supabase } = require('./supabaseClient');

// Notes now belong to a notebook (a plain text label, defaulting to
// 'General') so they can be organized into more than one running list per
// clan — e.g. "War Planning" vs "Roster Ideas" — instead of one flat pile.

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

// Real Postgres full-text search (see the migration SQL alongside this file)
// instead of fetching everything and substring-matching client-side — scales
// with the notebook's actual size rather than however many notes exist total.
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

// Distinct notebook names in use for a clan, for populating a picker in the
// UI. 'General' is always included even before any note has been saved to
// it, since it's the default every note falls into.
async function listNotebooks(clanTag) {
  if (!supabase) return ['General'];
  const { data, error } = await supabase
    .from('personal_notes')
    .select('notebook')
    .eq('clan_tag', clanTag);
  if (error) throw new Error(error.message);
  const names = new Set((data || []).map((r) => r.notebook).filter(Boolean));
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
