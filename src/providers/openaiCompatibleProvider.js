// Generic vision provider for anything speaking the OpenAI chat-completions
// vision format: image_url content parts + a text response. Covers
// OpenRouter, a local Ollama/LM Studio server with a vision model, Groq,
// Together.ai, or any other OpenAI-compatible endpoint - set
// OPENAI_COMPATIBLE_BASE_URL / _API_KEY / _MODEL in .env to point at it.
//
// This is the "bring your own model" escape hatch: if your provider isn't
// Runware and isn't already OpenAI-compatible, copy this file, adapt the
// request/response shape to match your API, and register it in
// visionProvider.js loadProvider().

async function ask(imageBuffer, mimeType, question) {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
  const model = process.env.OPENAI_COMPATIBLE_MODEL;
  if (!baseUrl || !model) {
    throw new Error(
      'OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL must both be set in .env when ' +
      'VISION_PROVIDER=openai-compatible (OPENAI_COMPATIBLE_API_KEY too, unless your endpoint needs no auth).'
    );
  }

  const base64 = imageBuffer.toString('base64');
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (json.error) {
    throw new Error('Provider error: ' + JSON.stringify(json.error));
  }
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text !== 'string') {
    throw new Error('Unexpected response shape: ' + JSON.stringify(json));
  }

  // Most OpenAI-compatible providers report token usage, not a flat USD
  // cost - leave costUsd null rather than guess at a $/token conversion the
  // server can't verify. Set OPENAI_COMPATIBLE_PRICE_PER_1M_INPUT/_OUTPUT in
  // .env if you want this provider to estimate it from json.usage instead.
  let costUsd = null;
  const priceIn = parseFloat(process.env.OPENAI_COMPATIBLE_PRICE_PER_1M_INPUT || '');
  const priceOut = parseFloat(process.env.OPENAI_COMPATIBLE_PRICE_PER_1M_OUTPUT || '');
  if (json.usage && !Number.isNaN(priceIn) && !Number.isNaN(priceOut)) {
    const { prompt_tokens = 0, completion_tokens = 0 } = json.usage;
    costUsd = (prompt_tokens / 1e6) * priceIn + (completion_tokens / 1e6) * priceOut;
  }

  return { text, costUsd };
}

module.exports = { ask };
