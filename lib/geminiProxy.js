// Gemini's REST API has a completely different request/response shape than
// Sarvam's OpenAI-compatible one (contents+parts instead of messages,
// systemInstruction separate from the conversation, etc). Rather than
// touch the frontend's chat logic, this module absorbs that difference:
// it accepts the exact same { messages, temperature, max_tokens, tools }
// shape the frontend already sends (tools in OpenAI's function-calling
// format), and hands back the exact same { choices: [{ message,
// finish_reason }] } shape Sarvam returns — including message.tool_calls
// in OpenAI's shape when Gemini calls a function — so war-room.html only
// ever has to know one request/response format, regardless of which
// provider is selected.
//
// Default model kept current as of Sept 2026 — Gemini's flash line moves
// fast, so if this starts 404ing, check https://ai.google.dev/gemini-api/docs/models
// for the current id and update this default (or just pass `model` in the
// request body, which now overrides it — see callGemini below).
const GEMINI_MODEL = 'gemini-3.6-flash';

const https = require('https');

// --- Request side: our OpenAI-shaped messages/tools -> Gemini's contents/tools ---

// Gemini expects a function's result back as a normal turn with role
// 'user' (not a separate 'function' role — that's the one part of this
// mapping that's easy to get wrong; Google's own function-calling guide
// confirms user is correct: the function_response must be wrapped in a
// message with role='user').
function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  // OpenAI tool messages only carry a tool_call_id, not the function name —
  // Gemini's functionResponse needs the name, so track id -> name as we walk
  // through, from the assistant message that made each call.
  const callIdToName = new Map();

  for (const m of messages || []) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      m.tool_calls.forEach((tc) => {
        if (tc.id && tc.function?.name) callIdToName.set(tc.id, tc.function.name);
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { /* leave empty on bad JSON */ }
        const part = { functionCall: { name: tc.function?.name, args } };
        // Gemini 3 models attach a thoughtSignature to the first functionCall
        // part of a turn and reject the next request with a 400 if it isn't
        // echoed back verbatim on that same part when this turn is replayed.
        // extractToolCalls() below stashes it on the OpenAI-shaped tool_call
        // as _geminiThoughtSignature for exactly this reason — put it back
        // here as a sibling of functionCall, not nested inside it.
        if (tc._geminiThoughtSignature) part.thoughtSignature = tc._geminiThoughtSignature;
        parts.push(part);
      });
      contents.push({ role: 'model', parts });
      continue;
    }

    if (m.role === 'tool') {
      const name = callIdToName.get(m.tool_call_id) || 'unknown_function';
      let response;
      try { response = JSON.parse(m.content); } catch (e) { response = { result: m.content }; }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
      continue;
    }

    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '' }] });
  }

  return {
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents,
  };
}

// Our TOOL_DEFINITIONS in war-room.html are already OpenAI's
// { type: 'function', function: { name, description, parameters } } shape.
// Gemini's REST API accepts the same lowercase JSON-Schema `type` values
// (object/string/integer/etc) directly in functionDeclarations.parameters —
// confirmed against Google's own function-calling REST examples — so this
// is a reshaping, not a schema rewrite.
function toGeminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const functionDeclarations = tools
    .filter((t) => t.type === 'function' && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

// --- Response side: Gemini's candidate -> our OpenAI-shaped choice ---

function mapFinishReason(geminiReason) {
  if (geminiReason === 'MAX_TOKENS') return 'length';
  if (geminiReason) return 'stop';
  return undefined;
}

// Gemini doesn't give function calls an id at all — war-room.html's tool
// loop needs *some* id per call to pair each tool result back up (it's the
// thing tool_call_id on the way back references), so we mint one. It only
// has to be unique within this one response, not globally.
//
// thoughtSignature lives as a sibling of functionCall on the Part object,
// not inside it — and per Gemini's own docs, in a parallel-tool-call
// response (several functionCall parts in one turn) only the FIRST part
// carries one; the rest legitimately have none. We stash whatever's present
// on each part as _geminiThoughtSignature so toGeminiContents() above can
// echo it back on the right part later — OpenAI's tool_calls shape has no
// native field for this, so a private one carries it through untouched as
// war-room.html passes the object back and forth.
function extractToolCalls(parts) {
  const calls = (parts || [])
    .filter((p) => p.functionCall)
    .map((p, idx) => ({
      id: `gemini_call_${idx}`,
      type: 'function',
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {}),
      },
      ...(p.thoughtSignature ? { _geminiThoughtSignature: p.thoughtSignature } : {}),
    }));
  return calls.length ? calls : undefined;
}

function callGemini(apiKey, { messages, temperature, maxOutputTokens, tools, model }) {
  return new Promise((resolve, reject) => {
    const { systemInstruction, contents } = toGeminiContents(messages);
    const geminiTools = toGeminiTools(tools);
    const payload = JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(geminiTools ? { tools: geminiTools } : {}),
      generationConfig: {
        temperature: temperature ?? 0.3,
        maxOutputTokens: maxOutputTokens ?? 1536,
      },
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      // model can be overridden per-request (coc-local-proxy.js passes the
      // client's chosen model through) — falls back to GEMINI_MODEL above
      // if the caller doesn't specify one.
      path: `/v1beta/models/${model || GEMINI_MODEL}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Gemini API ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          const candidate = parsed.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const text = parts.filter((p) => p.text).map((p) => p.text).join('');
          const toolCalls = extractToolCalls(parts);
          resolve({
            choices: [{
              finish_reason: mapFinishReason(candidate?.finishReason),
              message: {
                role: 'assistant',
                content: text || null,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
            }],
          });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { callGemini };
