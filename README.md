# MCP for OpenGL Android Development and Automation

An [MCP](https://modelcontextprotocol.io) server for AI coding agents (Claude Code, Cursor, etc.) to test Android apps whose entire UI is drawn inside a single opaque OpenGL/Vulkan/Metal surface — Cocos2d-x, Unity, Unreal, raw OpenGL, libGDX, and similar engines.

## The problem this solves

`adb shell uiautomator dump` and every accessibility-tree-based automation tool (including most MCP mobile-automation servers) work by inspecting the native Android view hierarchy — buttons, labels, their text and coordinates. That works great for a normal Android UI built out of native views.

It does **not** work for a game or app that renders its entire UI as textures inside one `GLSurfaceView`. From the accessibility tree's point of view, there is exactly one opaque view on screen with no children, no labels, no coordinates for anything inside it. There is nothing to inspect — the screen is a black box, no matter how much UI is actually on it.

The only real observation channel left is **screenshots**. This server is built around that fact as the normal case, not as an occasional fallback.

### How this differs from mobile-mcp

[mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) is the general-purpose MCP mobile automation server, and it's a good default choice for normal native apps: accessibility-tree first (fast, cheap, no vision model, no image tokens), falling back to screenshots + coordinates only when the tree doesn't give it what it needs.

For an OpenGL-canvas app, that fallback isn't occasional — it's the *only* path that ever works, every single time. `mobile-mcp-opengl` is built for that case specifically, and makes two different design choices as a result:

1. **No accessibility-tree attempt at all.** There's nothing to gain from trying — it always comes back empty for these apps — so every tool here goes straight to screenshot + vision.
2. **Vision analysis goes through a pluggable, separate provider** (see below), not through whatever model is running the calling agent. A functional QA loop over a game can easily run into the hundreds of screenshot checks per session; routing all of that through your main coding-agent's own vision costs both real money and tokens/context you'd rather spend on the actual coding work. Here the screenshot bytes never enter the calling agent's context at all — only the provider's short text answer does.

## Why combined action+observe tools, not separate primitives

A naive design exposes `tap`, `screenshot`, and `ask` as three separate tools. That forces the calling agent to orchestrate a multi-step loop for every single interaction: tap → take a screenshot → hand it to a vision step → read the result → decide what to do next. Each of those is a separate tool call and a separate turn — burning tokens on coordination instead of on the actual test logic, and giving more surface area for the agent to drop a step, misorder them, or reason about stale state between calls.

Instead, this server exposes **combined** tools — `tap_and_ask`, `swipe_and_ask`, `long_press_and_ask` — that perform the action, wait briefly, take the screenshot, ask the vision provider, and return one short answer, all as a single tool call. A multi-step test scenario ends up costing roughly one agent turn per meaningful check, not three or four.

Plain `screenshot_ask` (observe only, no action) and cheap non-vision tools (`type_text`, `press_key`, `logcat_grep`) are also available for the parts of a test flow that don't need this pattern.

## Tools

| Tool | What it does | Vision call? |
|---|---|---|
| `screenshot_ask` | Screenshot, then ask a short question about it | Yes |
| `tap_and_ask` | Tap (x, y), wait, screenshot, ask | Yes |
| `swipe_and_ask` | Swipe/drag (x1,y1)→(x2,y2), wait, screenshot, ask | Yes |
| `long_press_and_ask` | Long-press (x, y) for a duration, wait, screenshot, ask | Yes |
| `record_and_ask` | Optional action, then N screenshots spaced apart in time, ask the same question about each frame | Yes (N calls) |
| `type_text` | Type into the currently focused field | No |
| `press_key` | Send an Android `KEYCODE_*` event (back, enter, ...) | No |
| `logcat_grep` | Read recent logcat, optionally filtered by regex | No |
| `vision_spend_report` | Report today's cumulative vision spend and thresholds | No |

Prefer `logcat_grep` over a vision call whenever what you need is already in a log line (crashes, your own debug prints, network errors) — it's free and exact, a vision call is neither.

### Checking animations: `record_and_ask`

Single-frame tools can't tell you whether something *animates* correctly (does the strength indicator pulse smoothly, does a label fly up and fade out, does a sprite spring back to its start position). `record_and_ask` performs one optional action (tap or swipe, or neither), waits `waitMs` (same meaning as `waitMs` in `tap_and_ask`/`swipe_and_ask` — time for the UI to start reacting before the first frame), then captures `frameCount` screenshots spaced `intervalMs` apart, and returns one short answer per frame — the calling agent gets a timeline in one tool call instead of orchestrating N separate screenshot+ask round trips itself.

**Why one vision call per frame, not one call with all frames bundled together.** Runware's `imageCaption` turns out to accept an undocumented `inputImages` array (plural) alongside the documented single `inputImage` — tested directly against the API. It works cleanly for exactly 2 images (a same-request before/after comparison came back correct and coherent). At 3+ images in one request, both that array parameter *and* a manually-composited side-by-side "filmstrip" image produced truncated or malformed answers in testing — the small 7B vision model apparently loses coherence past a certain combined visual+instruction load in one call. Sequential single-image calls (this tool's approach) were reliable at any frame count tested, and aren't meaningfully more expensive: cost is dominated by response length (see below) rather than call count, so N short sequential answers costs about the same as, or less than, one long multi-image answer. If your own provider handles multi-image requests more reliably, this is an obvious place to optimize — see "Bring your own model".

## Setup

```bash
git clone <this repo>
cd mobile-mcp-opengl
npm install
cp .env.example .env
# edit .env: at minimum set RUNWARE_API_KEY (or switch VISION_PROVIDER, see below)
```

Requires `adb` on `PATH` (or `ADB_PATH` set in `.env`), and a running/connected device or emulator. If more than one is attached, set `ADB_DEVICE_SERIAL` (see `adb devices`).

### Register with Claude Code

Add a `.mcp.json` in your project root (this file is typically project-local and git-ignored, since it usually points at a machine-specific path or holds machine-specific env overrides):

```json
{
  "mcpServers": {
    "mobile-opengl": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-mcp-opengl/src/server.js"]
    }
  }
}
```

Claude Code picks this up automatically for the project. The server reads its own `.env` (next to `package.json` in this repo) for all configuration — the calling agent never needs to know or pass any API key itself.

## Cost model — read this before running a long QA session

**Response length drives cost, not image size.** This was measured empirically against the default Runware/Qwen2.5-VL-7B-Instruct provider: the same question asked with a forced one-word answer cost the same ($0.0006) across image sizes from 360×360 up to 1600×2400 (retina-class). The same 1024×1024 image with an open-ended "describe this" prompt cost $0.0013–0.0019 — 2-3x more — purely because the model wrote a longer answer, not because the image was bigger.

Practical implications:
- **Don't bother downsampling screenshots** before sending them — it doesn't meaningfully reduce cost for this provider, and you lose detail you might need.
- **Always phrase questions to force short answers**: yes/no, a number, a short label, a tiny JSON object with a couple of fields. Every tool in this server appends a short-answer instruction automatically, but a vague open-ended question ("what do you see?") can still push the model toward a longer answer than a specific one ("is the error dialog visible? yes/no").

At ~$0.0006/call for well-formed short questions, a 500-call QA session costs roughly $0.30. The same volume of open-ended "describe the screen" questions can run 2-3x that.

### Built-in spend guardrails

Every vision call is logged to `.vision-log.jsonl` (JSONL, one entry per call: timestamp, question, answer, cost). Two independent protections sit on top of that log, both provider-agnostic (they work off whatever `costUsd` a provider reports):

- **Per-call alert** (`VISION_ALERT_USD`, default `$0.0015`): if a single call comes back above this, the tool's response includes a `[COST ALERT]` note telling you the model likely ignored the short-answer instruction — a signal to reformulate the question, not something to silently eat.
- **Daily cap** (`VISION_SESSION_CAP_USD`, default `$2.00`): once today's cumulative logged spend reaches this, every further vision call is **refused outright** (before it reaches the provider) until the cap is raised or the day rolls over. This is a hard stop against a runaway loop, not just a warning.

Call `vision_spend_report` any time to check today's total without making a device or vision call.

If a provider can't report a cost (see `openai-compatible` below), calls from it are logged with `costUsd: null` and never trigger the alert or count toward the cap — the guardrails simply can't protect spend they have no visibility into.

## Bring your own model

Vision analysis goes through `src/providers/visionProvider.js`, which picks a provider by name from `VISION_PROVIDER` in `.env`. Two are built in:

- **`runware`** (default) — talks to [Runware.ai](https://runware.ai)'s `imageCaption` task directly, using Qwen2.5-VL-7B-Instruct (AIR id `runware:152@2`) by default. Runware and OpenRouter are two separate services with separate API keys and model catalogs — this talks to Runware directly, not through OpenRouter.
- **`openai-compatible`** — a generic provider for anything speaking the OpenAI chat-completions vision format (image_url content parts). Works with OpenRouter, a local Ollama/LM Studio server running a vision model, Groq, Together.ai, or any other compatible endpoint. Configure `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` in `.env`. Most OpenAI-compatible APIs report token usage rather than a flat dollar cost; set `OPENAI_COMPATIBLE_PRICE_PER_1M_INPUT`/`_OUTPUT` if you want this provider to estimate `costUsd` from that (otherwise cost tracking/guardrails are inert for this provider, per the note above).

To add a fully custom provider (a self-hosted model, a different API shape entirely), copy `src/providers/openaiCompatibleProvider.js` as a starting point, implement:

```js
async function ask(imageBuffer, mimeType, question) {
  // return { text: string, costUsd: number | null }
}
module.exports = { ask };
```

and register it with a name in `src/providers/visionProvider.js`'s `loadProvider()`.

## License

MIT

---

Developed by [Kinect.PRO](https://kinect.pro)
