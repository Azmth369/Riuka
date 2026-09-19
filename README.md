# Riuka — Clash of Clans Clan War Room

A self-contained web dashboard + AI analyst for a Clash of Clans clan: live war,
CWL and Clan Capital tracking, a searchable history archive in Supabase, personal
notebooks with full-text search, and an AI chat that answers clan questions from
real data — with a deterministic query engine underneath so counts, filters and
rankings never depend on the model's arithmetic.

> Riuka is the upgraded successor of the old coc-watcher dashboard. The Discord
> bot ([ponyo](https://github.com/Azmth369/ponyo)) is a sibling project with its
> own database — they share design ideas, not data.

## Architecture

```
Browser (war-room.html, vanilla JS)
   │  fetch()
   ▼
coc-local-proxy.js  (zero-framework Node server — the ONLY credential holder)
   ├── /coc/*          → Clash of Clans API (via cocproxy.royaleapi.dev)
   ├── /sarvam/chat    → Sarvam AI  (OpenAI-compatible)
   ├── /gemini/chat    → Google Gemini (translated by lib/geminiProxy.js)
   ├── /ask            → chat pipeline (context + tools + engine, see below)
   └── /war-history, /attack-log, /capital-history, /cwl-history,
       /notes, /notebooks, /chats, /chat-messages, /sync-status
        → lib/*.js → Supabase (service-role key, server-side only)
```

The browser never sees the CoC token, AI keys, or the Supabase service-role key.
A background poller (runs when `CLAN_TAG` is set) keeps wars, CWL, capital raids,
the roster and attack logs recording even with no browser open, logging each run
to `sync_runs`.

### The chat pipeline (`POST /ask`)

1. **Deterministic engine first** — `lib/queryEngine.js` parses the question
   into a query plan (scope → operation → filters). `structured_query` runs
   against the database + live CoC API and is declared **authoritative** for
   filters, counts, rankings and event facts; the AI only words the answer.
2. **Scoped context** — `lib/chatContext.js` builds a category-filtered context
   (live war snapshot, war members, recent wars + monthly rollups, capital
   season + absentees, roster) from the **current question only**; conversation
   history is used for pronoun resolution, never for scope detection.
3. **Tools** — the model can call `search_war_history`, `search_capital_raids`,
   `search_notes`, `get_attack_details`, `search_attack_log` to pull exact
   records from the complete archive on demand.
4. **Fallbacks** — provider failures are classified (quota / context window /
   key / transient) with automatic Sarvam ↔ Gemini fallback, and a final
   deterministic text fallback so factual answers still arrive if both AIs are
   down. Full answers are stored in `ai_answers` for 30 days ("See more").

### Data model (Supabase)

`clans`, `players`, `player_snapshots` (rolling roster history, last 12
batches), `wars` + `war_members` + `war_attacks`, `cwl_seasons` + `cwl_rounds` +
`cwl_wars` + `cwl_attacks`, `capital_raids` + `capital_attacks`, `sync_runs`,
`ai_answers`, plus Riuka-only tables: `personal_notes` (Postgres full-text
search) and `chat_conversations` / `chat_messages` (web chat history).

Event identity is **instant-based, never string-based**: CoC timestamps
(`20260915T195740.000Z`) are normalized to canonical UTC ISO instants before any
key comparison, so the same war can never be saved twice because one poll
returned a differently-formatted or one-second-shifted timestamp.

## Run locally

```bash
cp .env.example .env    # fill in keys
npm install
npm start               # → http://localhost:8787
npm test                # unit tests (query engine, transforms)
```

## Deploy (Render)

The service is defined in `render.yaml` (free plan). Set the secrets
(`COC_TOKEN`, `SARVAM_TOKEN`, `GEMINI_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CLAN_TAG`) in Render's Environment tab — they are
not synced from the repo. Optional: `RUKA_ACCESS_TOKEN` locks every API route
behind a shared secret; `ALLOWED_ORIGIN` locks CORS to one origin.

## Repo layout

```
coc-local-proxy.js        HTTP server, routes, background poller
lib/                      data layer + engine (all Supabase/AI access)
supabase/migrations/      schema DDL, in apply order
test/                     node --test unit tests
war-room.html             the dashboard (single file, no build step)
```
