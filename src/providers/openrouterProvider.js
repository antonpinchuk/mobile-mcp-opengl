// OpenRouter vision provider - talks to https://openrouter.ai/api/v1's
// chat-completions endpoint (standard OpenAI vision format: image_url
// content parts), using OpenRouter's own model catalog and slug format
// (provider/model, e.g. "qwen/qwen3-vl-30b-a3b-instruct") rather than
// Runware's AIR format (creator:family@version) - see openaiProvider.js
// for the Runware-hosted equivalent, and don't mix the two id formats up.
//
// *** NOT LIVE-TESTED. *** Written directly from OpenRouter's published API
// docs (chat-completions endpoint, vision content-part format, and the
// `usage.cost`/`usage.cost_details` authoritative-cost fields OpenRouter
// documents as always included in every response - no special request
// parameter needed) rather than verified against a real account, because no
// OpenRouter API key was available when this was written (see README
// "Switching models" for why: it requires signing up for a separate paid
// account, which isn't something this project's agent can or should do on
// its own). This SHOULD work as written if OpenRouter's documented request/
// response shape is accurate, but "should work per the docs" is a
// materially weaker claim than "confirmed against the live API" (compare
// openaiProvider.js, which was smoke-tested end to end before being
// committed) - budget for a first real call to surface a docs/reality gap.
// If you test this against a real OpenRouter key and it needs a fix, a PR
// is very welcome - please also update this comment once it's confirmed
// working, so the next reader knows the "not live-tested" caveat no longer
// applies.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

async function ask(imageBuffer, mimeType, question) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set - get one from https://openrouter.ai/keys (requires a funded OpenRouter account).');
  }
  if (!model) {
    throw new Error('OPENROUTER_MODEL not set - e.g. "qwen/qwen3-vl-30b-a3b-instruct". See README "Switching models" for tiers.');
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

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (json.error) {
    throw new Error('OpenRouter error: ' + JSON.stringify(json.error));
  }
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text !== 'string') {
    throw new Error('Unexpected OpenRouter response shape: ' + JSON.stringify(json));
  }

  // Per OpenRouter's docs, usage.cost is the authoritative per-request USD
  // cost, always included (no `usage: {include: true}` needed - that
  // parameter is documented as deprecated/no-op). Falls back to null (not
  // an estimate) if a response somehow doesn't have it, since guessing a
  // wrong cost is worse than admitting this provider can't report one for
  // that call - see visionProvider.js contract.
  const costUsd = json.usage && typeof json.usage.cost === 'number' ? json.usage.cost : null;

  return { text, costUsd };
}

module.exports = { ask };
