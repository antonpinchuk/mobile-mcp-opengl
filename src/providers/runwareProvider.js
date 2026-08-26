// Default vision provider: Runware.ai's task-specific `imageCaption`
// endpoint (NOT the same as Runware's general chat/completions endpoint -
// see openaiProvider.js for that one). Cheapest option at a measured
// ~$0.0006 per short-answer call - see this repo's README "Cost model" for
// how that price was measured and why response length (not image size) is
// what actually drives it.
//
// This endpoint only accepts a small, undocumented set of AIR ids - most
// ids that "look right" (sequential numbers, general chat model ids from
// Runware's own broader catalog) come back `invalidCaptionModel`. The two
// confirmed-working ones as of this writing, found by trial against the
// live API (see README "Switching models" for the comparison methodology):
//   - runware:150@2 (LLaVA-1.6-Mistral-7B) (default) - gave correct/coherent
//     answers in every comparison run against runware:152@2 on this
//     project's own test screenshots (correctly identified a UI element
//     152@2 missed entirely, and never produced the token-repetition
//     garbage 152@2 did on one test). A different model, not a config
//     tweak of 152@2 - same price though.
//   - runware:152@2 (Qwen2.5-VL-7B-Instruct) - the older default. Kept
//     available via RUNWARE_VISION_MODEL for anyone who wants to reproduce
//     the comparison, but not recommended as a default anymore.
//
// Runware and OpenRouter are two separate services with separate API keys
// and separate model catalogs - don't confuse them. This provider talks to
// Runware directly, not through OpenRouter.

const RUNWARE_ENDPOINT = 'https://api.runware.ai/v1';
const DEFAULT_MODEL_AIR = 'runware:150@2';

async function ask(imageBuffer, mimeType, question) {
  const apiKey = process.env.RUNWARE_API_KEY;
  if (!apiKey) {
    throw new Error('RUNWARE_API_KEY not set - copy .env.example to .env and fill it in.');
  }
  const modelAir = process.env.RUNWARE_VISION_MODEL || DEFAULT_MODEL_AIR;
  const base64 = imageBuffer.toString('base64');

  const body = [
    { taskType: 'authentication', apiKey },
    {
      taskType: 'imageCaption',
      taskUUID: crypto.randomUUID(),
      inputImage: `data:${mimeType};base64,${base64}`,
      prompt: question,
      model: modelAir,
      includeCost: true,
    },
  ];

  const res = await fetch(RUNWARE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (json.errors && json.errors.length) {
    throw new Error('Runware error: ' + JSON.stringify(json.errors));
  }
  const result = json.data && json.data[0];
  if (!result) {
    throw new Error('Unexpected Runware response shape: ' + JSON.stringify(json));
  }

  return {
    text: result.text,
    costUsd: typeof result.cost === 'number' ? result.cost : null,
  };
}

const crypto = require('crypto');

module.exports = { ask };
