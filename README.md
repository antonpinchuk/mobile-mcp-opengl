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

Prefer `logcat_grep` over a vision call whenever what you need is already in a log line (crashes, your own debug prints, network errors) — it's free and exact, a vision call is neither. Same idea for `tap`/`hold`/`swipe_hold`/`release`: use these instead of their `_and_ask` counterparts for any step in a gesture you don't need to *observe* — e.g. `release` instead of `release_and_ask` once `record_swipe_and_ask` already answered what you needed mid-drag, or `hold` for a setup step before the leg you actually want to check. They share the same held-touch state as the `_and_ask` tools (see "Composing a multi-step gesture" below), so a `hold` → `swipe_hold_and_ask` → `release` chain works exactly like an all-`_and_ask` chain, just without paying for observation you don't need.

### Drag/hold support: real continuous touch, and composing a multi-step gesture

`swipe_and_ask` and `record_and_ask` used to shell out to a single `adb shell input swipe`/`draganddrop` call. On at least one tested app (a Cocos2d-x/OpenGL word game with a custom `EventListenerTouchOneByOne`-based drag handler), that single-shot gesture — and a hand-rolled loop of separate `adb shell input touchscreen motionevent DOWN/MOVE.../UP` invocations with no timing control — never produced a recognized drag, while a real finger on the same build dragged normally. The suspected cause: each separate `adb shell` invocation is its own short-lived process, so the events arrive at the input dispatcher as disconnected single-shot injections rather than one continuous touch stream.

**The fix**, in `src/adb.js`: the same low-level `input touchscreen motionevent DOWN/MOVE/UP` primitives, but driven from a single JS-side timer loop within one async function call, pacing MOVE events roughly every 20ms (tunable via `MOVE_STEP_MS`) against wall-clock target times so total gesture duration stays close to what's requested regardless of individual adb-call latency. `swipe_and_ask` and `record_and_ask` now both go through this (`adb.drag()`) instead of the old single-shot call — this is not limited to the four new tools below.

**Confirmed working end-to-end**, with a real repro methodology (not a single lucky run): 10 consecutive `swipe_and_ask`-style drag+release calls in a row through the actual MCP server (real `Client`/`StdioClientTransport`, real vision provider calls in between, not direct function calls) against a freshly-restarted instance of `com.mindkins.game` — 10/10 produced a real `onWordTouchEnded` callback on the app side (confirmed via two temporary `CCLOG` lines added to the app's C++ touch handlers for this investigation), a visible connection line, and a DB-level edge row. A composed `touchDown → continueDrag → continueDrag → touchUp` sequence (the same primitives `swipe_hold_and_ask`/`release_and_ask` use) was also confirmed correct: the strength-indicator thermometer sprite is visible during each held/hover phase, including across multi-second gaps between tool calls (a real vision-provider round trip is ~5-14s; idle gaps up to 8s while held produced no difference), and the connection registers at the final leg's endpoint.

**A follow-up investigation found the earlier "sometimes silently does nothing" reports were real symptoms but the wrong diagnosis** — the touch-injection code in `adb.js` was not at fault. Three distinct, unrelated causes were isolated, each independently reproduced and then ruled out or (for the third) traced to an app-side bug outside this repo's scope:
1. **Wrong target coordinates.** The single biggest source of "the drag did nothing" in this investigation was simply computing device-pixel coordinates from a *displayed* (scaled-down) screenshot without applying the scale factor correctly, landing the drag's start/end points outside any tappable sprite's bounding box. `onWordTouchBegan` correctly returns `false` for a touch that doesn't hit a word icon (by design — it lets the touch pass through to menu buttons etc.), so this produces exactly the "nothing happened, no callback fired" signature that looks identical to a real injection failure. A pixel-boundary scan of the actual PNG (not the visually-scaled preview) resolved this immediately; 10/10 and 8/8 repeat batches at correctly-measured coordinates never reproduced a missing callback.
2. **Test-harness logcat truncation, not a device symptom.** Several "silent failure" batches during this investigation turned out to be an artifact of the *test script*, not the app or `adb.js`: `adb logcat -d -t 500` only returns the most recent 500 lines, and this emulator produces roughly 100 logcat lines/second even at idle (~700 lines in a 7-second window) — comfortably enough to scroll a single `CCLOG` marker out of a 500-line tail before the test script reads it, especially with a real ~5-14s vision-call gap between tool calls. Re-running the identical scenario with an unbounded `logcat -d` read turned a measured "1/10 fired" into "10/10 fired" with no other change. This is a lesson for writing tests against this server, not a bug in it.
3. **A real app-side bug, found and isolated, not in this repo.** After ruling out (1) and (2), one genuine, deterministically-reproducible (6/6) stuck-icon case remained: dragging a tile onto a partner it *already has a live (non-deleted) connection with* leaves the dragged icon sitting wherever it was released instead of flying back to its pickup origin. Reading `GameScene::updateExistingConnectionLocally` (`Classes/Scenes/GameScene.cpp`) explains why: the fly-back `MoveTo` action is gated behind `isRestoring`, which is only `true` when the edge was previously tombstoned (`deleted`) and is now being revived — a plain reconnect/weight-nudge on an already-live edge takes the same function but never sets that flag, so the fly-back block is skipped entirely. This matches the human tester's original report ("release → icon didn't return, got stuck hovering over another one") exactly, and is unrelated to touch injection — the touch was received, hover-tracked, and released correctly throughout; the app's own post-release animation logic just has this gap for one specific case. Filed here for visibility since it was found during this investigation, but fixing it is out of scope for an MCP server repo (it's `Classes/Scenes/GameScene.cpp` application code) and no change was made to it.

Two temporary `CCLOG` lines remain in `GameScene.cpp` (`onWordTouchEnded`, `onWordTouchCancelled`) from this and the prior investigation — useful for anyone re-verifying this against the app in the future, harmless to leave in.

**Composing a multi-step gesture across tool calls.** Eight tools share one module-level "is a touch currently held, and where" variable in `adb.js` (a plain in-memory variable — this server is one long-lived process per session, so it doesn't need to survive a restart or be shared across sessions):

- `hold_and_ask` / `hold` — press down at (x, y) and hold. Starts a new held touch; fails if one is already held.
- `swipe_hold_and_ask` / `swipe_hold` — drag to (x2, y2) and hold. If a touch is already held, `x1`/`y1` are ignored and the drag **continues from wherever that touch currently is** — the app sees one unbroken finger-down stream across both tool calls. If nothing is held, `x1`/`y1` are required and this starts a fresh touch.
- `release_and_ask` / `release` — sends UP wherever the currently-held touch is. Fails with a clear error if nothing is held.
- `record_swipe_and_ask` — screenshots at independently-specified `intervalMs`/`frameCount` while a drag is still in flight (see below); optionally leaves the touch held at the end via `holdAtEnd` for a following `swipe_hold_and_ask`/`swipe_hold`/`release_and_ask`/`release`.

The `_and_ask` and quiet (no-suffix) versions of each are fully interchangeable mid-chain — they read and write the same held-touch state, so `hold` → `swipe_hold_and_ask` → `swipe_hold` → `release_and_ask` is one valid continuous gesture, not four independent taps: whichever variant you pick per step, only pay for a screenshot+vision call on the steps you actually need to observe. Calling any hold/swipe-hold variant with nothing held and no `x1`/`y1`, or any release/continuing swipe-hold variant with nothing held at all, raises a clear error rather than silently starting a wrong gesture.

### Checking animations: `record_and_ask`

Single-frame tools can't tell you whether something *animates* correctly (does the strength indicator pulse smoothly, does a label fly up and fade out, does a sprite spring back to its start position). `record_and_ask` performs one optional action (tap or swipe, or neither), waits `waitMs` (same meaning as `waitMs` in `tap_and_ask`/`swipe_and_ask` — time for the UI to start reacting before the first frame), then captures `frameCount` screenshots spaced `intervalMs` apart, and returns one short answer per frame — the calling agent gets a timeline in one tool call instead of orchestrating N separate screenshot+ask round trips itself.

**Why one vision call per frame, not one call with all frames bundled together.** Runware's `imageCaption` turns out to accept an undocumented `inputImages` array (plural) alongside the documented single `inputImage` — tested directly against the API. It works cleanly for exactly 2 images (a same-request before/after comparison came back correct and coherent). At 3+ images in one request, both that array parameter *and* a manually-composited side-by-side "filmstrip" image produced truncated or malformed answers in testing — the small 7B vision model apparently loses coherence past a certain combined visual+instruction load in one call. Sequential single-image calls (this tool's approach) were reliable at any frame count tested, and aren't meaningfully more expensive: cost is dominated by response length (see below) rather than call count, so N short sequential answers costs about the same as, or less than, one long multi-image answer. If your own provider handles multi-image requests more reliably, this is an obvious place to optimize — see "Bring your own model".

### Checking mid-drag behavior: `record_swipe_and_ask`

`record_and_ask` samples frames before/after a one-shot action; it can't tell you what happened *while a finger was still moving* — does a dragged piece track the finger smoothly, does a drop-zone light up partway through the drag rather than only on release. `record_swipe_and_ask` starts a real continuous drag (the same `adb.drag()` implementation `swipe_and_ask` uses — see "Drag/hold support" above) from `(x1, y1)` to `(x2, y2)` over `durationMs`, and concurrently — while that drag is still in progress — captures `frameCount` screenshots spaced `intervalMs` apart, independent of the drag's own internal MOVE cadence. If `frameCount * intervalMs` exceeds `durationMs` the drag finishes early and the later frames capture the held/released end state rather than genuine mid-drag frames, so keep the two in proportion if every frame specifically needs to be mid-gesture. Pass `holdAtEnd: true` to leave the touch down afterward (e.g. to continue with `swipe_hold_and_ask`) instead of releasing.

## Setup

```bash
git clone <this repo>
cd mobile-mcp-opengl
npm install
cp .env.example .env
# edit .env: at minimum set OPENAI_API_KEY (same value as your Runware key - see
# "Bring your own model" below for what the default VISION_PROVIDER=openai actually
# talks to, and how to switch providers/models)
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

Every vision call is logged to `.data/vision-log.jsonl` (JSONL, one entry per call: timestamp, question, answer, cost) — same gitignored `.data/` directory as the saved screenshots (see "Screenshot files" below). Two independent protections sit on top of that log, both provider-agnostic (they work off whatever `costUsd` a provider reports):

- **Per-call alert** (`VISION_ALERT_USD`, default `$0.0015`): if a single call comes back above this, the tool's response includes a `[COST ALERT]` note telling you the model likely ignored the short-answer instruction — a signal to reformulate the question, not something to silently eat.
- **Daily cap** (`VISION_SESSION_CAP_USD`, default `$2.00`): once today's cumulative logged spend reaches this, every further vision call is **refused outright** (before it reaches the provider) until the cap is raised or the day rolls over. This is a hard stop against a runaway loop, not just a warning.

Call `vision_spend_report` any time to check today's total without making a device or vision call.

If a provider can't report a cost (see `openai-compatible` below), calls from it are logged with `costUsd: null` and never trigger the alert or count toward the cap — the guardrails simply can't protect spend they have no visibility into.

## Screenshot files

Every screenshot a vision call actually looked at is saved to `.data/screenshots/` (gitignored), named by capture timestamp (`2026-08-25T18-04-31-288Z.png`) so a directory listing is already in chronological order. Every `*_and_ask` tool's response includes the absolute path of the screenshot(s) it used — both the calling agent and the human can open that exact file directly, independent of what the vision model said about it.

This matters because of a real failure mode worth naming plainly: **the vision provider's text answer is not always correct.** In practice it has been observed confidently answering wrong about color, presence/absence of an element, and even returning malformed JSON for a screen that was, by direct pixel inspection of the saved file, completely different from the answer. Don't treat a `*_and_ask` answer as ground truth for anything you're about to act on with consequence — when an answer looks surprising or a bug report doesn't reproduce as described, open the saved screenshot file yourself (or have the calling agent read it) before trusting the text.

`.data/screenshots/` is **not cleaned up automatically** — nothing in this server deletes old files, ages them out, or caps the directory's size. Clear it yourself (`rm -rf .data/screenshots`, or delete individual files) whenever a session's screenshots are no longer needed; a long QA session can accumulate a lot of them.

## Bring your own model

Vision analysis goes through `src/providers/visionProvider.js`, which picks a provider by name from `VISION_PROVIDER` in `.env`. Four are built in:

- **`runware`** — talks to [Runware.ai](https://runware.ai)'s task-specific `imageCaption` endpoint, using AIR id `runware:150@2` by default — the cheapest option, ~$0.0006/short-answer call. This endpoint only accepts a small, undocumented set of AIR ids — general Runware chat/vision model ids (Gemini, GPT-5.6, ...) are **not** valid here and return `invalidCaptionModel`; for those, use `openai` below instead.
- **`openai`** (active in `.env.example`, default model GPT-5.6 Terra) — despite the name, does **not** require an OpenAI account by default: it talks to **Runware's own `/v1/chat/completions` endpoint** (same `RUNWARE_API_KEY`, no separate account, reaches Runware's full chat/vision catalog under their AIR id format `creator:family@version` — a *different* model registry than the `runware` provider's `imageCaption` task above). Point `OPENAI_BASE_URL` at `https://api.openai.com/v1` with a real `OPENAI_API_KEY` instead for genuinely OpenAI-hosted inference (implements the standard shape directly; not verified against that specific host, only against Runware's).
- **`openrouter`** — talks to [OpenRouter](https://openrouter.ai)'s catalog under its own slug format (`provider/model`, e.g. `qwen/qwen3-vl-30b-a3b-instruct`) — a large, cheap selection including Qwen3-VL, which isn't available as a vision model through either Runware endpoint above (Runware's chat catalog only has Qwen3.5 as *text-only*, no vision, as of when this was checked). **Not live-tested** — see `src/providers/openrouterProvider.js` for why (no funded OpenRouter account was available to verify against) and please open a PR if you try it and it needs a fix.
- **`openai-compatible`** — a generic escape hatch for anything else speaking the OpenAI chat-completions vision format (image_url content parts): a local Ollama/LM Studio server, Groq, Together.ai, or OpenRouter itself if you'd rather hand-configure it here instead of using the dedicated `openrouter` provider. Configure `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` in `.env`. Most OpenAI-compatible APIs report token usage rather than a flat dollar cost; set `OPENAI_COMPATIBLE_PRICE_PER_1M_INPUT`/`_OUTPUT` if you want this provider to estimate `costUsd` from that (otherwise cost tracking/guardrails are inert for this provider, per the note above).

### Switching models if accuracy is insufficient

The `runware` provider's models are **small** vision models, and small vision models get things wrong on real screenshots — not rarely. Directly reproduced against this server's own saved screenshots (see "Screenshot files" above): asked "what color is the vertical bar on the left edge?" against a screenshot with an orange fill inside a pale-blue tube, the older `runware:152@2` (Qwen2.5-VL-7B) confidently answered **"Black"** — not a garbled response, a clean, wrong, confident one — and on a separate question it emitted a run of garbage repeated tokens instead of a real answer. `runware:150@2` (the current default for that provider) did noticeably better across the same test cases and costs the same, but is still the same weight class of model — don't skip "Screenshot files" above if you haven't read it yet; a wrong-looking answer is common enough with either `runware`-provider model that checking the saved file yourself needs to be routine, not a last resort.

If the `runware` provider isn't accurate enough, switch to `openai` (bigger model, same Runware account, no new signup) or `openrouter` (much cheaper per token, but not verified here — see above). The same test image was compared across several models reachable through `openai` pointed at Runware's chat endpoint:

| Model (Runware AIR id) | Answer | Cost/call (this test) | Notes |
|---|---|---|---|
| `runware:152@2` (Qwen2.5-VL-7B, via `runware` provider) | "Black" | ~$0.0006 | Wrong. The old default; also produced garbage repeated tokens on a separate test question. |
| `runware:150@2` (via `runware` provider, current default) | "Blue" | ~$0.0006 | Correct-ish, same price — see README default rationale above. |
| `google:gemini@3.5-flash-lite` | "White" | low | Wrong. |
| `google:gemini@3.6-flash` | "Blue" | ~$0.006 | Correct-ish (tube is pale blue), but used ~600 completion tokens on a one-word question. |
| **`openai:gpt@5.6-terra` (default for the `openai` provider)** | "Blue" | ~$0.006 | Correct-ish, ~4 completion tokens — respects the short-answer instruction, fastest (~1s). |
| `openai:gpt@5.6-sol` | "Blue" | ~$0.015 | Correct-ish, same token discipline as Terra, no accuracy edge over it in this test — costs more for no observed benefit here. |
| `google:gemini@3.1-pro` | "Blue" | ~$0.014 | Correct-ish, but ignored the short-answer instruction entirely — ~975 reasoning tokens and 10+ seconds for a one-word question. |

None of these are infallible — a follow-up multi-question comparison against other saved screenshots from the same session had both Terra and Gemini 3.6 Flash answer wrong on 2 of 3 questions (miscounting visible icons, missing a small colored marker) despite both being "the good tier" in the table above. Bigger/pricier is a real improvement over the confidently-wrong small-model failure mode, not a guarantee of correctness — the practice in "Screenshot files" (verify against the saved file when it matters) still applies regardless of which model or provider you're running.

`.env.example` has the `openai` provider active with `openai:gpt@5.6-terra` as its default, `google:gemini@3.6-flash` and `google:gemini@3.1-pro` given as commented alternatives (swap in their `OPENAI_MODEL`/`_PRICE_PER_1M_*` trio to switch), and the `openrouter` provider documented (commented) as an unverified but meaningfully-cheaper-per-token alternative if you want to try Qwen3-VL. Whichever you pick, the cost guidance in "Cost model" above still applies: short, specific questions keep even a pricier model's per-call cost down, since response length (not model size or image size) is still the dominant cost driver — Terra's token discipline in the table above is a direct illustration of why that matters in practice.

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
