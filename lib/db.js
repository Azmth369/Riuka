// Supabase service-role client (server-side only — bypasses RLS) plus small
// write helpers shared by the sync layer.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
} else {
  console.warn(
    '[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
    'history will not be saved or loaded until these are configured.'
  );
}

// Upsert rows, optionally ignoring duplicates (used when the natural-key
// unique constraint is the dedupe mechanism).
async function upsert(table, rows, { onConflict, ignoreDuplicates = false } = {}) {
  if (!supabase) return [];
  if (!rows || rows.length === 0) return [];
  const options = {};
  if (onConflict) options.onConflict = onConflict;
  if (ignoreDuplicates) options.ignoreDuplicates = true;
  const { data, error } = await supabase.from(table).upsert(rows, options).select();
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  return data || [];
}

async function remove(table, match) {
  if (!supabase) return null;
  let q = supabase.from(table).delete();
  for (const [col, val] of Object.entries(match)) q = q.eq(col, val);
  const { error } = await q;
  if (error) throw new Error(`${table} delete failed: ${error.message}`);
  return true;
}

module.exports = { supabase, upsert, remove };
