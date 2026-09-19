// The /ask pipeline: builds context for the current question, calls the
// requested provider (Sarvam first by default, Gemini as fallback — or the
// other way around), runs the tool-call loop, and falls back to the
// deterministic answer if every provider fails.
//
// Conversation history (from chat_messages, last 5 turns) is passed to the
// provider ONLY to resolve pronouns — the context itself was built from the
// current question alone (see chatContext.js).

const { buildContext, TOOL_DEFINITIONS, makeToolHandlers } = require('./chatContext');
const { answerDeterministically } = require('./deterministicAnswer');
const chatHistory = require('./chatHistory');
const { supabase } = require('./db');
const { callGemini } = require('./geminiProxy');

const MAX_TOOL_ROUNDS = 4;
const HISTORY_TURNS = 5;
const AI_ANSWER_RETENTION_DAYS = 30;
const TRUNCATE_AT = 900; // chars shown before "See more"

const SYSTEM_PROMPT = `You are a sharp, concise Clash of Clans clan analyst for a clan war-room dashboard.

RULES:
1. DATABASE CONTEXT is provided as JSON with the question. structured_query, when present, is AUTHORITATIVE for any filter, count, ranking, ordering or event fact — restate it, never recompute or contradict it. live snapshots (current_war with source "live", capital_current_season) take priority over synced rows for current state.
2. Capital-raid participants lists only contain members who already attacked; "who has not attacked" comes from absentees, which is also provided.
3. Refer to players and the clan by plain name only — never show #-tags unless the person explicitly asks for a tag.
4. Answer the exact question; lead with the direct answer, then a short supporting summary. When asked to identify one player or a small handful, name just those — save full breakdowns for when asked to see everyone.
5. When the context does not contain what is asked, say so plainly. Never invent clan-specific data. Tools (search_war_history, search_capital_raids, search_notes, get_attack_details, search_attack_log) search the complete archive — call one when the question needs detail the context does not already include, instead of guessing.
6. Conversation history is included only to resolve pronouns and references; route every question by its own words.
7. Times shown to the user must be in IST (Asia/Kolkata), formatted DD/MM/YYYY HH:mm.

The old habit of recounting arrays by hand is exactly what structured_query makes unnecessary — trust it.`;

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

function classifyFailure(provider, status, bodyText) {
  const text = String(bodyText || '');
  return {
    provider,
    status: status ?? null,
    isQuotaOrRateLimit: status === 429 || /rate.?limit|quota|too many requests/i.test(text),
    isContextWindow: /context window|prompt_tokens|max_tokens|exceeds the model context|too many tokens/i.test(text),
    isAuth: status === 401 || status === 403 || /api key|unauthorized|forbidden/i.test(text),
    isTransient: [408, 429, 500, 502, 503, 504].includes(status),
    detail: text.slice(0, 300),
  };
}

async function callSarvam(messages, tools) {
  const key = process.env.SARVAM_TOKEN;
  if (!key) { const e = new Error('SARVAM_TOKEN is not set'); e.silent = true; throw e; }
  const model = process.env.SARVAM_MODEL || 'sarvam-2b';
  const body = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
    reasoning_effort: null,
  };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Sarvam ${res.status}: ${text.slice(0, 300)}`);
    err.failure = classifyFailure('sarvam', res.status, text);
    throw err;
  }
  const data = await res.json();
  return { shape: 'openai', data };
}

async function callGeminiProvider(messages, tools) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { const e = new Error('GEMINI_API_KEY is not set'); e.silent = true; throw e; }
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  // geminiProxy speaks the OpenAI shape and translates both ways, including
  // tool calling — so the loop below is provider-agnostic.
  const result = await callGemini(key, {
    model,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
    tools: tools && tools.length ? tools : undefined,
  });
  return { shape: 'openai', data: result };
}

// One provider attempt: call + tool loop. Returns { content, provider }.
async function askProvider(providerFn, providerLabel, messages, toolHandlers, tools) {
  const convo = [...messages];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { data } = await providerFn(convo, tools);
    const choice = data.choices && data.choices[0];
    const msg = choice && choice.message;
    const toolCalls = msg && msg.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length && round < MAX_TOOL_ROUNDS) {
      convo.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const fnName = call.function && call.function.name;
        const handler = toolHandlers[fnName];
        let result;
        try {
          const args = JSON.parse((call.function && call.function.arguments) || '{}');
          result = handler ? await handler(args) : { error: `Unknown tool: ${fnName}` };
        } catch (e) {
          result = { error: `Tool call failed: ${e.message}` };
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const content = (msg && msg.content && String(msg.content).trim()) ||
      (msg && msg.reasoning_content && String(msg.reasoning_content).trim()) || '';
    const hitLengthCap = choice && choice.finish_reason === 'length';
    if (!content || hitLengthCap) {
      const err = new Error(hitLengthCap ? 'The reply hit the response length limit before finishing.' : 'The model returned an empty response.');
      err.failure = { provider: providerLabel, status: null, isTransient: true, detail: err.message };
      throw err;
    }
    return { content, provider: providerLabel };
  }
  throw new Error('Too many tool rounds');
}

// ---------------------------------------------------------------------------
// The main entry: POST /ask
// ---------------------------------------------------------------------------

async function answerQuestion({ clanTag, question, conversationId, provider: preferred = 'sarvam' }) {
  const clean = String(question || '').trim();
  if (!clean) throw new Error('Question cannot be empty');

  // Context from the CURRENT question only.
  const context = await buildContext(clean, clanTag);

  // History (last N turns) merged only for pronoun resolution.
  let history = [];
  if (conversationId) {
    try {
      const msgs = await chatHistory.getMessages(conversationId);
      history = msgs.slice(-HISTORY_TURNS * 2).map(m => ({ role: m.role, content: m.content }));
    } catch (e) { /* history is optional */ }
  }

  const contextBlock = `Current clan data (JSON):\n${JSON.stringify(context)}`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: contextBlock },
    ...history,
    { role: 'user', content: clean },
  ];

  const toolHandlers = makeToolHandlers(clanTag);

  const order = preferred === 'gemini'
    ? [['gemini', callGeminiProvider], ['sarvam', callSarvam]]
    : [['sarvam', callSarvam], ['gemini', callGeminiProvider]];

  const failures = [];
  let success = null;
  for (const [label, fn] of order) {
    try {
      success = await askProvider(fn, label, messages, toolHandlers, TOOL_DEFINITIONS);
      break;
    } catch (err) {
      failures.push(err.failure || { provider: label, detail: err.message, isTransient: true });
      if (err.silent) continue;
      console.warn(`[ask] ${label} failed:`, err.message);
    }
  }

  let answer;
  let usedDeterministic = false;
  if (success) {
    answer = success.content;
  } else {
    // Final fallback: the deterministic answer, so factual questions still
    // get a correct reply when every provider is down.
    try {
      const det = await answerDeterministically(clean, clanTag);
      if (det && det.text) {
        answer = `${det.text}\n\n(Answered from structured clan data because the AI provider was unavailable — ask again shortly for a fuller reply.)`;
        usedDeterministic = true;
      }
    } catch (e) {
      console.error('[ask] deterministic fallback failed:', e.message);
    }
    if (!answer) {
      const err = new Error('All AI providers failed and no deterministic answer was available for this question.');
      err.failures = failures;
      throw err;
    }
  }

  // Persist the exchange (conversation + messages) and the full answer.
  let convoId = conversationId;
  try {
    if (!convoId) {
      const convo = await chatHistory.createConversation(clanTag, clean.slice(0, 60));
      convoId = convo && convo.id;
    }
    if (convoId) {
      await chatHistory.addMessage(convoId, 'user', clean);
      await chatHistory.addMessage(convoId, 'assistant', answer);
    }
  } catch (e) {
    console.warn('[ask] conversation persistence failed:', e.message);
  }

  let answerId = null;
  let truncated = null;
  if (answer.length > TRUNCATE_AT) {
    truncated = answer.slice(0, TRUNCATE_AT);
    try {
      if (supabase) {
        const expires = new Date(Date.now() + AI_ANSWER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('ai_answers')
          .insert({
            channel_id: convoId ? String(convoId) : null,
            user_id: 'web',
            provider: success ? success.provider : 'deterministic',
            question: clean,
            full_answer: answer,
            expires_at: expires,
          })
          .select('id')
          .single();
        if (error) throw new Error(error.message);
        answerId = data && data.id;
      }
    } catch (e) {
      console.warn('[ask] ai_answers persistence failed:', e.message);
    }
  }

  return {
    answer: truncated != null ? truncated : answer,
    full_answer_truncated: truncated != null,
    answer_id: answerId,
    conversation_id: convoId,
    provider: success ? success.provider : 'deterministic',
    used_deterministic_fallback: usedDeterministic,
    provider_failures: failures.length ? failures : undefined,
  };
}

// GET /answer?id=... — powers "See more".
async function getFullAnswer(id) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('ai_answers')
    .select('id, question, full_answer, provider, created_at, expires_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return { expired: true };
  return data;
}

module.exports = { answerQuestion, getFullAnswer, SYSTEM_PROMPT };
