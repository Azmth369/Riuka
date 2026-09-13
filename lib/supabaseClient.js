// Server-side Supabase client.
//
// Uses the SERVICE ROLE key, which bypasses Row Level Security — this
// module must only ever be required from server code (coc-local-proxy.js),
// never bundled into or fetched by the browser.
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
    'CWL season history will not be saved or loaded until these are configured.'
  );
}

module.exports = { supabase };
