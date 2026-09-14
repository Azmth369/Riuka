// Gemini's REST API has a completely different request/response shape than
// Sarvam's OpenAI-compatible one (contents+parts instead of messages,
// systemInstruction separate from the conversation, etc). Rather than
// touch the frontend's chat logic, this module absorbs that difference:
// it accepts the exact same { messages, temperature, max_tokens } shape
// the frontend already sends, and hands back the exact same
// { choices: [{ message, finish_reason }] } shape Sarvam returns — so
// war-room.html only ever has to know one response format, regardless of
// which provider is selected.

const https = require('https');

const GEMINI_MODEL = 'gemini-3.6-flash';

function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  for (const m of messages || []) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  return {
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents,
  };
}

function mapFinishReason(geminiReason) {
  if (geminiReason === 'MAX_TOKENS') return 'length';
  if (geminiReason) return 'stop';
  return undefined;
}

function callGemini(apiKey, { messages, temperature, maxOutputTokens }) {
  return new Promise((resolve, reject) => {
    const { systemInstruction, contents } = toGeminiContents(messages);
    const payload = JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: temperature ?? 0.3,
        maxOutputTokens: maxOutputTokens ?? 1536,
      },
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
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
          const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
          resolve({
            choices: [{
              finish_reason: mapFinishReason(candidate?.finishReason),
              message: { role: 'assistant', content: text },
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
