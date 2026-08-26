// OpenAI-protocol vision provider - talks to any endpoint speaking the
// standard OpenAI chat-completions vision format (image_url content parts).
// Despite the name, this does NOT require an OpenAI account: it defaults to
// Runware's OWN /v1/chat/completions endpoint (same RUNWARE_API_KEY as the
// `runware` provider, no separate account), which reaches Runware's general
// chat/vision catalog (Gemini, GPT-5.6, Claude, ...) under Runware's AIR id
// format (creator:family@version) - a DIFFERENT model registry than the
// `runware` provider's `imageCaption` task (see runwareProvider.js), and
// NOT interchangeable with it: an AIR id valid here will usually be
// rejected there and vice versa.
//
// Point OPENAI_BASE_URL at api.openai.com instead if you want genuinely
// OpenAI-hosted inference with an OpenAI-issued key.
//
// Smoke-tested against Runware's chat endpoint with openai:gpt@5.6-terra -
// see README "Switching models if accuracy is insufficient" for the full
// comparison this default was chosen from (correct answers, respects the
// short-answer instruction, fastest of the tiers compared, ~$0.006/call in
// that testing). NOT tested against api.openai.com directly (no OpenAI key
// was available to verify with) - the request/response shape is standard
// enough that it should work unchanged, but treat that path as unverified
// until someone confirms it.

const DEFAULT_BASE_URL = 'https://api.runware.ai/v1';
const DEFAULT_MODEL = 'openai:gpt@5.6-terra';
// $/1M tokens for the default model, from Runware's own catalog (verified
// live against https://api.runware.ai/v1/models) - matches OpenAI's own
// published GPT-5.6 Terra pricing exactly, i.e. Runware is not marking this
// model up. Used to compute costUsd automatically for the default model
// without requiring OPENAI_PRICE_PER_1M_INPUT/_OUTPUT to be set; overridden
// by those env vars if you change OPENAI_MODEL to something else priced
// differently.
const DEFAULT_PRICE_PER_1M_INPUT = 2.0;
const DEFAULT_PRICE_PER_1M_OUTPUT = 12.0;

async function ask(imageBuffer, mimeType, question) {
  const baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY || process.env.RUNWARE_API_KEY;
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error(
      'No API key found for the openai provider - set OPENAI_API_KEY in .env (or RUNWARE_API_KEY, ' +
      'which this provider falls back to when pointed at the default Runware base URL).'
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

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (json.error) {
    throw new Error('OpenAI-protocol provider error: ' + JSON.stringify(json.error));
  }
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text !== 'string') {
    throw new Error('Unexpected response shape: ' + JSON.stringify(json));
  }

  // Explicit OPENAI_PRICE_PER_1M_* env vars win (needed if you change
  // OPENAI_MODEL to a different tier - see README "Switching models" for
  // the pricing table of ones already compared). Falls back to the
  // hardcoded default-model pricing above so cost tracking/guardrails work
  // out of the box for the default model without extra .env setup.
  let costUsd = null;
  const envPriceIn = parseFloat(process.env.OPENAI_PRICE_PER_1M_INPUT || '');
  const envPriceOut = parseFloat(process.env.OPENAI_PRICE_PER_1M_OUTPUT || '');
  const priceIn = !Number.isNaN(envPriceIn) ? envPriceIn : DEFAULT_PRICE_PER_1M_INPUT;
  const priceOut = !Number.isNaN(envPriceOut) ? envPriceOut : DEFAULT_PRICE_PER_1M_OUTPUT;
  if (json.usage) {
    const { prompt_tokens = 0, completion_tokens = 0 } = json.usage;
    costUsd = (prompt_tokens / 1e6) * priceIn + (completion_tokens / 1e6) * priceOut;
  }

  return { text, costUsd };
}

module.exports = { ask };
