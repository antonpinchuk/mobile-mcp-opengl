// Vision provider abstraction: anything that can answer a short question
// about a screenshot. Swap providers by setting VISION_PROVIDER in .env
// (see .env.example) - no code changes needed for the built-in ones, and
// dropping in a new file here + one line in loadProvider() is enough for a
// custom one.
//
// Contract every provider must satisfy:
//   async ask(imageBuffer: Buffer, mimeType: string, question: string): Promise<{
//     text: string,          // the model's answer
//     costUsd: number | null // per-call cost if the provider reports one, else null
//   }>
//
// Providers should NOT try to be clever about prompt engineering beyond what
// they're given - the server-level short-answer discipline (see
// server.js SHORT_ANSWER_SUFFIX) is applied once, above this layer, so it
// works the same regardless of which provider is plugged in.

function loadProvider() {
  const name = (process.env.VISION_PROVIDER || 'runware').toLowerCase();
  switch (name) {
    case 'runware':
      return require('./runwareProvider');
    case 'openai':
      // Runware's general chat/completions endpoint by default (Gemini,
      // GPT-5.6, Claude, ...) - NOT the same model registry as `runware`'s
      // imageCaption task. Point OPENAI_BASE_URL at api.openai.com instead
      // for genuinely OpenAI-hosted inference. See openaiProvider.js.
      return require('./openaiProvider');
    case 'openrouter':
      // NOT live-tested (see openrouterProvider.js) - written from
      // OpenRouter's published docs, needs a funded OpenRouter account this
      // project's agent doesn't have. Reports are welcome if you try it.
      return require('./openrouterProvider');
    case 'openai-compatible':
      // Generic escape hatch for any other OpenAI-vision-compatible
      // endpoint (a local Ollama/LM Studio server, Groq, Together.ai, or
      // OpenRouter itself if you'd rather configure it by hand instead of
      // using the dedicated `openrouter` provider above).
      return require('./openaiCompatibleProvider');
    default:
      throw new Error(
        `Unknown VISION_PROVIDER "${name}". Built-in options: "runware", "openai", "openrouter", "openai-compatible". ` +
        `To add your own, create src/providers/<name>Provider.js exporting an async ask(imageBuffer, mimeType, question) ` +
        `function, then add a case for it in src/providers/visionProvider.js loadProvider().`
      );
  }
}

module.exports = { loadProvider };
