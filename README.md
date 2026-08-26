# MCP for OpenGL Android Development and Automation

An [MCP](https://modelcontextprotocol.io) server for AI coding agents (Claude Code, Cursor, etc.) to test Android apps whose entire UI is drawn inside a single opaque OpenGL/Vulkan/Metal surface — Cocos2d-x, Unity, Unreal, raw OpenGL, libGDX, and similar engines.

## The problem this solves

`adb shell uiautomator dump` and every accessibility-tree-based automation tool (including most MCP mobile-automation servers) work by inspecting the native Android view hierarchy — buttons, labels, their text and coordinates. That works great for a normal Android UI built out of native views.

It does **not** work for a game or app that renders its entire UI as textures inside one `GLSurfaceView`. From the accessibility tree's point of view, there is exactly one opaque view on screen with no children, no labels, no coordinates for anything inside it. There is nothing to inspect — the screen is a black box, no matter how much UI is actually on it.

The only real observation channel left is **screenshots**. This server is built around that fact as the normal case, not as an occasional fallback.

### How this differs from mobile-mcp

Unlike [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) (a good default for normal native apps, accessibility-tree first with a screenshot fallback), this server skips the accessibility-tree attempt entirely — it's pointless for OpenGL-canvas apps — and routes every vision call through a **pluggable, separate provider** (see "Bring your own model" below) rather than the calling agent's own vision, so screenshot bytes never enter the agent's context — only the provider's short answer does.

## Tools

| Tool | What it does | Vision call? |
|---|---|---|
| `screenshot_ask` | Screenshot, then ask a short question about it | Yes |
| `tap_and_ask` | Tap (x, y), wait, screenshot, ask | Yes |
| `swipe_and_ask` | Swipe/drag (x1,y1)→(x2,y2), wait, screenshot, ask | Yes |
| `hold_and_ask` | Press down at (x, y) and HOLD (no release), wait, screenshot, ask | Yes |
| `swipe_hold_and_ask` | Drag to (x2, y2) and HOLD (no release) - continues an existing hold if one is active | Yes |
| `release_and_ask` | Release whatever touch is currently held, wait, screenshot, ask | Yes |
| `tap` | Tap (x, y) - no screenshot, no vision call | No |
| `hold` | Press down at (x, y) and HOLD (no release) - no screenshot, no vision call | No |
| `swipe_hold` | Drag to (x2, y2) and HOLD (no release) - no screenshot, no vision call - continues an existing hold if one is active | No |
| `release` | Release whatever touch is currently held - no screenshot, no vision call | No |
| `long_press_and_ask` | Long-press (x, y) for a duration, wait, screenshot, ask | Yes |
| `record_and_ask` | Optional action, then N screenshots spaced apart in time, ask the same question about each frame | Yes (N calls) |
| `record_swipe_and_ask` | Like `record_and_ask`, but the N screenshots are taken WHILE a drag is still in flight | Yes (N calls) |
| `type_text` | Type into the currently focused field | No |
| `press_key` | Send an Android `KEYCODE_*` event (back, enter, ...) | No |
| `logcat_grep` | Read recent logcat, optionally filtered by regex | No |
| `vision_spend_report` | Report today's cumulative vision spend and thresholds | No |

See "Tools usage" below for how the `_and_ask`/quiet pairs, drag/hold composition, and the two multi-frame tools actually work together.

## Setup

```bash
git clone <this repo>
cd mobile-mcp-opengl
npm install
cp .env.example .env
# edit .env: at minimum set RUNWARE_API_KEY - see "Bring your own model" below
# for what the default VISION_PROVIDER=runware actually talks to, and how to
# switch providers/models
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

## Using these instructions in your own agent

[`AGENTS.md`](./AGENTS.md) is a short, portable set of behavioral rules for any agent using this server — how to use the tools well, not what they do (that's the "Tools" table above). Either link to it from your own `CLAUDE.md`/`AGENTS.md`/equivalent, or copy its content in and adapt as needed. Don't duplicate the tool reference or cost/model tables here into your own instructions — link back instead, so they don't drift out of sync.

No built-in provider has a reliable confidence signal an agent could threshold on to decide when to double-check (confirmed directly — GPT-5 rejects `logprobs`, Runware's `imageCaption` returns no confidence field, and verbalized self-confidence is known to be unreliable in general). `AGENTS.md`'s substitute: always check the saved screenshot yourself when an answer matters, not just when a model claims low confidence.

## Cost model — read this before running a long QA session

**Response length drives cost, not image size.** Measured empirically against `runware:150@2` (LLaVA-1.6-Mistral-7B, the `runware` provider's default — see "Bring your own model" below): the same question asked with a forced one-word answer cost the same ($0.0006) across image sizes from 360×360 up to 1600×2400 (retina-class). The same 1024×1024 image with an open-ended "describe this" prompt cost $0.0013–0.0019 — 2-3x more — purely because the model wrote a longer answer, not because the image was bigger.

Practical implications:
- **Don't bother downsampling screenshots** before sending them — it doesn't meaningfully reduce cost, and you lose detail you might need.
- **Always phrase questions to force short answers**: yes/no, a number, a short label, a tiny JSON object with a couple of fields. Every tool in this server appends a short-answer instruction automatically, but a vague open-ended question ("what do you see?") can still push the model toward a longer answer than a specific one ("is the error dialog visible? yes/no").

**What a 500-call QA session costs, by provider** (500 calls is a realistic session — a few dozen test scenarios, each a handful of check-ins):

| Provider (default model) | Cost/call (short answer) | 500-call session |
|---|---|---|
| `runware` (`runware:150@2`, the active `.env.example` default) | ~$0.0006 | ~$0.30 |
| `openai` (`openai:gpt@5.6-terra`, an alternative — see below) | ~$0.006 | ~$3.11 |

The `openai` provider costs about 10x more per call for a meaningfully bigger model. In this server's own small side-by-side comparison it read as somewhat more reliable, but not by enough to obviously justify that 10x — see "Switching models if accuracy is insufficient" below for the actual test results, and run your own comparison against your app's screens before assuming that holds for your case. `runware` is the recommended default here; reach for `openai` for a specific case where the cheap default is demonstrably failing you, not as a blanket upgrade. Both numbers roughly double or triple if your questions are open-ended instead of short (same response-length effect as above) — budget accordingly for whichever provider you're running.

### Built-in spend guardrails

Every vision call is logged to `.data/vision-log.jsonl` (JSONL, one entry per call: timestamp, question, answer, cost) — same gitignored `.data/` directory as the saved screenshots (see "Screenshot files" below). Two independent protections sit on top of that log, both provider-agnostic (they work off whatever `costUsd` a provider reports):

- **Per-call alert** (`VISION_ALERT_USD`, default `$0.0015`): if a single call comes back above this, the tool's response includes a `[COST ALERT]` note telling you the model likely ignored the short-answer instruction — a signal to reformulate the question, not something to silently eat.
- **Daily cap** (`VISION_SESSION_CAP_USD`, default `$2.00`): once today's cumulative logged spend reaches this, every further vision call is **refused outright** (before it reaches the provider) until the cap is raised or the day rolls over. This is a hard stop against a runaway loop, not just a warning.

Call `vision_spend_report` any time to check today's total without making a device or vision call.

If a provider can't report a cost (see `openai-compatible` in "Bring your own model" below), calls from it are logged with `costUsd: null` and never trigger the alert or count toward the cap — the guardrails simply can't protect spend they have no visibility into.

## Tools usage

### Why combined action+observe tools, not separate primitives

A naive design exposes `tap`, `screenshot`, and `ask` as three separate tools. That forces the calling agent to orchestrate a multi-step loop for every single interaction: tap → take a screenshot → hand it to a vision step → read the result → decide what to do next. Each of those is a separate tool call and a separate turn — burning tokens on coordination instead of on the actual test logic, and giving more surface area for the agent to drop a step, misorder them, or reason about stale state between calls.

Instead, this server exposes **combined** tools — `tap_and_ask`, `swipe_and_ask`, `long_press_and_ask` — that perform the action, wait briefly, take the screenshot, ask the vision provider, and return one short answer, all as a single tool call. A multi-step test scenario ends up costing roughly one agent turn per meaningful check, not three or four.

Plain `screenshot_ask` (observe only, no action) and cheap non-vision tools (`type_text`, `press_key`, `logcat_grep`) are also available for the parts of a test flow that don't need this pattern.

Prefer `logcat_grep` over a vision call whenever what you need is already in a log line (crashes, your own debug prints, network errors) — it's free and exact, a vision call is neither. Same idea for `tap`/`hold`/`swipe_hold`/`release`: use these instead of their `_and_ask` counterparts for any step in a gesture you don't need to *observe* — e.g. `release` instead of `release_and_ask` once `record_swipe_and_ask` already answered what you needed mid-drag, or `hold` for a setup step before the leg you actually want to check. They share the same held-touch state as the `_and_ask` tools (see "Composing a multi-step gesture" below), so a `hold` → `swipe_hold_and_ask` → `release` chain works exactly like an all-`_and_ask` chain, just without paying for observation you don't need.

### Drag/hold support: real continuous touch, and composing a multi-step gesture

A single `adb shell input swipe`/`draganddrop` call, or a hand-rolled loop of separate `adb shell input touchscreen motionevent DOWN/MOVE.../UP` invocations with no timing control, is not guaranteed to register as a real drag on every engine's custom touch handler — each separate `adb shell` call is its own short-lived process, so the events can arrive at the input dispatcher as disconnected single-shot injections rather than one continuous touch stream. Confirmed directly: on one tested Cocos2d-x app with a custom drag handler, neither approach produced a recognized drag while a real finger did.

**The fix**, in `src/adb.js`: the same low-level `motionevent DOWN/MOVE/UP` primitives, driven from a single JS-side timer loop within one async function call, pacing MOVE events roughly every 20ms (tunable via `MOVE_STEP_MS`) against wall-clock target times. All drag-capable tools go through this (`adb.drag()`), not a single-shot call.

**Case study — drag-and-drop test on a Cocos2d-x game:** a composed `touchDown → continueDrag → continueDrag → touchUp` sequence (the same primitives `swipe_hold_and_ask`/`release_and_ask` use) produced a real touch-end callback on the app side 10/10 runs, confirmed via temporary debug logging added to the app's touch handlers for this investigation — including across multi-second gaps between tool calls while a touch was held. Two apparent "sometimes silently does nothing" failures turned out not to be this server's fault: (1) device-pixel coordinates computed from a *displayed* (scaled-down) screenshot instead of the real image dimensions, landing the touch outside any tappable element's bounds — see `AGENTS.md`; (2) `adb logcat -d -t 500` only returning the most recent 500 lines, scrolling a debug marker out of the tail before a slower test script (with real vision-call round trips in between) could read it — use an unbounded `logcat -d` read instead. A third, genuine app-side animation bug was also found and isolated this way, filed with the app's own maintainers rather than fixed here (out of scope for an MCP server repo) — the touch itself was received, tracked, and released correctly throughout.

**Composing a multi-step gesture across tool calls.** Eight tools share one module-level "is a touch currently held, and where" variable in `adb.js` (a plain in-memory variable — this server is one long-lived process per session, so it doesn't need to survive a restart or be shared across sessions):

- `hold_and_ask` / `hold` — press down at (x, y) and hold. Starts a new held touch; fails if one is already held.
- `swipe_hold_and_ask` / `swipe_hold` — drag to (x2, y2) and hold. If a touch is already held, `x1`/`y1` are ignored and the drag **continues from wherever that touch currently is** — the app sees one unbroken finger-down stream across both tool calls. If nothing is held, `x1`/`y1` are required and this starts a fresh touch.
- `release_and_ask` / `release` — sends UP wherever the currently-held touch is. Fails with a clear error if nothing is held.
- `record_swipe_and_ask` — screenshots at independently-specified `intervalMs`/`frameCount` while a drag is still in flight (see below); optionally leaves the touch held at the end via `holdAtEnd` for a following `swipe_hold_and_ask`/`swipe_hold`/`release_and_ask`/`release`.

The `_and_ask` and quiet (no-suffix) versions of each are fully interchangeable mid-chain — they read and write the same held-touch state, so `hold` → `swipe_hold_and_ask` → `swipe_hold` → `release_and_ask` is one valid continuous gesture, not four independent taps: whichever variant you pick per step, only pay for a screenshot+vision call on the steps you actually need to observe. Calling any hold/swipe-hold variant with nothing held and no `x1`/`y1`, or any release/continuing swipe-hold variant with nothing held at all, raises a clear error rather than silently starting a wrong gesture.

### Checking animations: `record_and_ask`

Single-frame tools can't tell you whether something *animates* correctly (does an indicator pulse smoothly, does a label fly up and fade out, does a sprite spring back to its start position). `record_and_ask` performs one optional action (tap or swipe, or neither), waits `waitMs` (same meaning as `waitMs` in `tap_and_ask`/`swipe_and_ask` — time for the UI to start reacting before the first frame), then captures `frameCount` screenshots spaced `intervalMs` apart, and returns one short answer per frame — the calling agent gets a timeline in one tool call instead of orchestrating N separate screenshot+ask round trips itself.

**Why one vision call per frame, not one call with all frames bundled together.** Runware's `imageCaption` turns out to accept an undocumented `inputImages` array (plural) alongside the documented single `inputImage` — tested directly against the API. It works cleanly for exactly 2 images (a same-request before/after comparison came back correct and coherent). At 3+ images in one request, both that array parameter *and* a manually-composited side-by-side "filmstrip" image produced truncated or malformed answers in testing — the small 7B vision model apparently loses coherence past a certain combined visual+instruction load in one call. Sequential single-image calls (this tool's approach) were reliable at any frame count tested, and aren't meaningfully more expensive: cost is dominated by response length (see "Cost model" above) rather than call count, so N short sequential answers costs about the same as, or less than, one long multi-image answer. If your own provider handles multi-image requests more reliably, this is an obvious place to optimize — see "Bring your own model".

### Checking mid-drag behavior: `record_swipe_and_ask`

`record_and_ask` samples frames before/after a one-shot action; it can't tell you what happened *while a finger was still moving* — does a dragged piece track the finger smoothly, does a drop-zone light up partway through the drag rather than only on release. `record_swipe_and_ask` starts a real continuous drag (the same `adb.drag()` implementation `swipe_and_ask` uses — see "Drag/hold support" above) from `(x1, y1)` to `(x2, y2)` over `durationMs`, and concurrently — while that drag is still in progress — captures `frameCount` screenshots spaced `intervalMs` apart, independent of the drag's own internal MOVE cadence. If `frameCount * intervalMs` exceeds `durationMs` the drag finishes early and the later frames capture the held/released end state rather than genuine mid-drag frames, so keep the two in proportion if every frame specifically needs to be mid-gesture. Pass `holdAtEnd: true` to leave the touch down afterward (e.g. to continue with `swipe_hold_and_ask`) instead of releasing.

### Screenshot files

Every screenshot a vision call actually looked at is saved to `.data/screenshots/` (gitignored), named by capture timestamp (`2026-08-25T18-04-31-288Z.png`) so a directory listing is already in chronological order. Every `*_and_ask` tool's response includes the absolute path of the screenshot(s) it used — both the calling agent and the human can open that exact file directly, independent of what the vision model said about it.

This matters because of a real failure mode worth naming plainly: **the vision provider's text answer is not always correct.** In practice it has been observed confidently answering wrong about color, presence/absence of an element, and even returning malformed JSON for a screen that was, by direct pixel inspection of the saved file, completely different from the answer. Don't treat a `*_and_ask` answer as ground truth for anything you're about to act on with consequence — when an answer looks surprising or a bug report doesn't reproduce as described, open the saved screenshot file yourself (or have the calling agent read it) before trusting the text.

`.data/screenshots/` is **not cleaned up automatically** — nothing in this server deletes old files, ages them out, or caps the directory's size. Clear it yourself (`rm -rf .data/screenshots`, or delete individual files) whenever a session's screenshots are no longer needed; a long QA session can accumulate a lot of them.

## Bring your own model

Vision analysis goes through `src/providers/visionProvider.js`, which picks a provider by name from `VISION_PROVIDER` in `.env`. Four are built in:

- **`runware`** (active in `.env.example`, default model `runware:150@2`) — talks to [Runware.ai](https://runware.ai)'s task-specific `imageCaption` endpoint, using AIR id `runware:150@2` (LLaVA-1.6-Mistral-7B) by default — the cheapest option, ~$0.0006/short-answer call, and the recommended default (see "Switching models" below for the accuracy tradeoff against the pricier `openai` option). This endpoint only accepts a small, undocumented set of AIR ids — general Runware chat/vision model ids (Gemini, GPT-5.6, ...) are **not** valid here and return `invalidCaptionModel`; for those, use `openai` below instead.
- **`openai`** (default model GPT-5.6 Terra) — despite the name, does **not** require an OpenAI account by default: it talks to **Runware's own `/v1/chat/completions` endpoint** (same `RUNWARE_API_KEY`, no separate account, reaches Runware's full chat/vision catalog under their AIR id format `creator:family@version` — a *different* model registry than the `runware` provider's `imageCaption` task above). Point `OPENAI_BASE_URL` at `https://api.openai.com/v1` with a real `OPENAI_API_KEY` instead for genuinely OpenAI-hosted inference (implements the standard shape directly; not verified against that specific host, only against Runware's). ~10x the cost of the `runware` default per call — see "Switching models" below before reaching for this as your default.
- **`openrouter`** — talks to [OpenRouter](https://openrouter.ai)'s catalog under its own slug format (`provider/model`, e.g. `qwen/qwen3-vl-30b-a3b-instruct`) — a large, cheap selection including Qwen3-VL, which isn't available as a vision model through either Runware endpoint above (Runware's chat catalog only has Qwen3.5 as *text-only*, no vision, as of when this was checked). **Not live-tested** — see `src/providers/openrouterProvider.js` for why (no funded OpenRouter account was available to verify against) and please open a PR if you try it and it needs a fix.
- **`openai-compatible`** — a generic escape hatch for anything else speaking the OpenAI chat-completions vision format (image_url content parts): a local Ollama/LM Studio server, Groq, Together.ai, or OpenRouter itself if you'd rather hand-configure it here instead of using the dedicated `openrouter` provider. Configure `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` in `.env`. Most OpenAI-compatible APIs report token usage rather than a flat dollar cost; set `OPENAI_COMPATIBLE_PRICE_PER_1M_INPUT`/`_OUTPUT` if you want this provider to estimate `costUsd` from that (otherwise cost tracking/guardrails are inert for this provider, per the note in "Built-in spend guardrails" above).

### Switching models if accuracy is insufficient

The `runware` provider's models are **small** vision models, and small vision models get things wrong on real screenshots — not rarely. Directly reproduced against this server's own saved screenshots (see "Screenshot files" above): asked "what color is the vertical bar on the left edge?" against a screenshot with an orange fill inside a pale-blue tube, the older `runware:152@2` (Qwen2.5-VL-7B) confidently answered **"Black"** — not a garbled response, a clean, wrong, confident one — and on a separate question it emitted a run of garbage repeated tokens instead of a real answer. `runware:150@2` (the current default for that provider) did noticeably better across the same test cases and costs the same, but is still the same weight class of model — don't skip "Screenshot files" above if you haven't read it yet; a wrong-looking answer is common enough with either `runware`-provider model that checking the saved file yourself needs to be routine, not a last resort.

If the `runware` provider isn't accurate enough for what you're checking, switch to `openai` (bigger model, same Runware account, no new signup) or `openrouter` (much cheaper per token, but not verified here — see above). The same test image was compared across several models reachable through `openai` pointed at Runware's chat endpoint:

| Model (Runware AIR id) | Answer | Cost/call (this test) | Notes |
|---|---|---|---|
| `runware:152@2` (Qwen2.5-VL-7B, via `runware` provider) | "Black" | ~$0.0006 | Wrong. The old default; also produced garbage repeated tokens on a separate test question. |
| `runware:150@2` (LLaVA-1.6-Mistral-7B, via `runware` provider, current default) | "Blue" | ~$0.0006 | Correct-ish, same price as 152@2 — a different model, not a config change. |
| `google:gemini@3.5-flash-lite` | "White" | low | Wrong. |
| `google:gemini@3.6-flash` | "Blue" | ~$0.006 | Correct-ish (tube is pale blue), but used ~600 completion tokens on a one-word question. |
| **`openai:gpt@5.6-terra` (default for the `openai` provider)** | "Blue" | ~$0.006 | Correct-ish, ~4 completion tokens — respects the short-answer instruction, fastest (~1s). |
| `openai:gpt@5.6-sol` | "Blue" | ~$0.015 | Correct-ish, same token discipline as Terra, no accuracy edge over it in this test — costs more for no observed benefit here. |
| `google:gemini@3.1-pro` | "Blue" | ~$0.014 | Correct-ish, but ignored the short-answer instruction entirely — ~975 reasoning tokens and 10+ seconds for a one-word question. |

None of these are infallible — a follow-up multi-question comparison against other saved screenshots from the same session had both Terra and Gemini 3.6 Flash answer wrong on 2 of 3 questions (miscounting visible icons, missing a small colored marker) despite both being "the good tier" in the table above. **Practical takeaway from this project's own (small, informal) comparison: `openai`/Terra did read as somewhat more reliable than the `runware` default, but not by enough to obviously justify ~10x the cost per call** — that's why `runware` stays the recommended default here rather than `openai`. This is not a claim that the two are equivalent in general, just what held in this project's own side-by-side runs — run your own comparison against your app's actual screens (the table above is a template for how) before deciding it applies to your case too. The practice in "Screenshot files" (verify against the saved file when it matters) applies regardless of which model or provider you're running, including the expensive ones.

`.env.example` has the `runware` provider active by default. The `openai` provider is documented (commented) with `openai:gpt@5.6-terra` as its own default if you enable it, `google:gemini@3.6-flash` and `google:gemini@3.1-pro` given as further commented alternatives (swap in their `OPENAI_MODEL`/`_PRICE_PER_1M_*` trio to switch), and the `openrouter` provider is documented (commented) as an unverified but meaningfully-cheaper-per-token alternative if you want to try Qwen3-VL. Whichever you pick, the cost guidance in "Cost model" above still applies: short, specific questions keep even a pricier model's per-call cost down, since response length (not model size or image size) is still the dominant cost driver.

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
