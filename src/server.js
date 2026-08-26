#!/usr/bin/env node
// mobile-mcp-opengl: an MCP server for testing Android apps whose entire UI
// lives inside one opaque OpenGL/Vulkan surface (Cocos2d-x, Unity, Unreal,
// raw OpenGL/libGDX...). `adb shell uiautomator dump` and every
// accessibility-tree-based tool see a single undifferentiated GLSurfaceView
// with no internal structure - there is nothing to inspect, so the only
// real channel is screenshots.
//
// This project is directly inspired by mobile-next/mobile-mcp
// (https://github.com/mobile-next/mobile-mcp), which does accessibility-tree
// automation first and falls back to screenshots+coordinates "when needed".
// For OpenGL-canvas apps that fallback isn't occasional - it's the only path
// that ever works, every single time. This server is built around that
// reality instead of treating it as an edge case, and its main design
// decision follows directly from it:
//
// COMBINED action+observe tools instead of separate primitives. A naive
// port of "tap" / "screenshot" / "ask" as three separate tools forces the
// calling agent to orchestrate a 3-4 step loop for every single interaction
// (tap -> take screenshot -> read it -> decide) - burning tokens on
// coordination and giving more surface for the agent to drop a step or
// misread state between calls. Here `tap_and_ask` (and friends) do the
// whole action -> screenshot -> vision-question -> answer round trip as ONE
// tool call, so a multi-step test scenario costs one agent turn per
// meaningful check instead of three or four.
//
// Vision analysis goes through a pluggable provider (src/providers/), NOT
// through whatever model is running the calling agent - see README "Bring
// your own model". The default provider is Runware.ai (Qwen2.5-VL-7B-
// Instruct), chosen because screenshot-heavy QA loops can run into the
// hundreds of calls per session, and that's expensive/rate-limited traffic
// you generally don't want competing with your main coding-agent model's
// budget.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('./loadEnv')(); // reads .env next to this package, see loadEnv.js

const adb = require('./adb');
const { loadProvider } = require('./providers/visionProvider');
const costTracker = require('./costTracker');
const screenshotStore = require('./screenshotStore');

const provider = loadProvider();

// Applied once here, on top of whatever question the agent asks - keeps the
// short-answer discipline uniform across every provider instead of each
// provider having to remember to do it. See README "Cost model" for why
// answer length (not image size) is the thing that actually drives cost for
// both Runware and typical OpenAI-compatible vision endpoints.
const SHORT_ANSWER_SUFFIX =
  ' Answer as briefly as possible - a single word, a short phrase, or a small JSON object with a ' +
  'few short fields. Do not write a paragraph or a full sentence unless the question explicitly asks for a description.';

async function askAboutImage(png, question) {
  costTracker.assertUnderCap();
  // Saved BEFORE the vision call so the file exists even if the provider
  // errors out or returns something unusable - the screenshot itself is
  // still worth having in that case.
  const screenshotPath = screenshotStore.save(png);
  const result = await provider.ask(png, 'image/png', question + SHORT_ANSWER_SUFFIX);
  const { alert, todayTotal } = costTracker.record({ question, answer: result.text, costUsd: result.costUsd });
  return { ...result, alert, todayTotal, screenshotPath };
}

async function askAboutScreen(question) {
  const png = await adb.screenshotPng();
  return askAboutImage(png, question);
}

function formatAnswer(question, result) {
  const parts = [result.text];
  if (result.screenshotPath) {
    // The model's answer is not always trustworthy (see README "Vision
    // provider accuracy") - the calling agent can Read this file directly
    // to check, and the human can open it too. Not cleaned up automatically
    // - see screenshotStore.js and README "Screenshot files".
    parts.push(`\n(screenshot: ${result.screenshotPath})`);
  }
  if (typeof result.costUsd === 'number') {
    parts.push(`\n(cost: $${result.costUsd.toFixed(4)}, today total: $${result.todayTotal.toFixed(4)})`);
  }
  if (result.alert) {
    parts.push(`\n[COST ALERT] ${result.alert}`);
  }
  return parts.join('');
}

const server = new McpServer({ name: 'mobile-mcp-opengl', version: '0.1.0' });

server.registerTool(
  'screenshot_ask',
  {
    title: 'Screenshot + ask',
    description:
      'Take a screenshot of the current screen and ask a short question about it (e.g. "Is there an error dialog visible?", ' +
      '"How many word icons are on screen?", "What color is the strength indicator?"). Use this when you need to check ' +
      'state WITHOUT performing an action first. Phrase the question so a short answer is possible (yes/no, a number, a ' +
      'short label) - see this server\'s README "Cost model".',
    inputSchema: { question: z.string().describe('A short, specific question about the current screen.') },
  },
  async ({ question }) => {
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'tap_and_ask',
  {
    title: 'Tap + screenshot + ask',
    description:
      'Tap at device screen coordinates (x, y), wait briefly for the UI to react, take a screenshot, and ask a short ' +
      'question about the result - all in one call. Use this for any "tap here, then check what happened" step instead ' +
      'of calling separate tap/screenshot/ask tools.',
    inputSchema: {
      x: z.number().describe('X coordinate in device pixels.'),
      y: z.number().describe('Y coordinate in device pixels.'),
      question: z.string().describe('A short, specific question about the screen after the tap.'),
      waitMs: z.number().optional().describe('Milliseconds to wait after the tap before screenshotting (default 500).'),
    },
  },
  async ({ x, y, question, waitMs }) => {
    await adb.tap(x, y);
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'swipe_and_ask',
  {
    title: 'Swipe/drag + screenshot + ask',
    description:
      'Swipe (or drag, for drag-and-drop UIs) from (x1, y1) to (x2, y2), wait briefly, take a screenshot, and ask a short ' +
      'question about the result - all in one call. Implemented as a real continuous touch (DOWN, then paced MOVE steps, ' +
      'then UP - see README "Drag/hold support"), not a single `adb shell input swipe` call, so this now works against ' +
      'custom touch-based drag handlers that ignored the old single-shot gesture. For a drag that needs to PAUSE at the ' +
      'destination before releasing (e.g. to screenshot mid-hold, or to continue on to a second destination), use ' +
      'swipe_hold_and_ask instead - this tool always releases at (x2, y2).',
    inputSchema: {
      x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
      durationMs: z.number().optional().describe('Swipe duration in ms (default 300; use longer for drag-and-drop hold gestures).'),
      question: z.string().describe('A short, specific question about the screen after the swipe.'),
      waitMs: z.number().optional().describe('Milliseconds to wait after the swipe before screenshotting (default 500).'),
    },
  },
  async ({ x1, y1, x2, y2, durationMs, question, waitMs }) => {
    await adb.swipe(x1, y1, x2, y2, durationMs ?? 300);
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'hold_and_ask',
  {
    title: 'Press down + hold (no movement) + screenshot + ask',
    description:
      'Press down at (x, y) and HOLD - the finger stays down, no UP is sent - wait briefly, take a screenshot, and ask a ' +
      'short question about the result. Unlike long_press_and_ask (which presses AND releases before screenshotting), this ' +
      'leaves the touch held so a later swipe_hold_and_ask/release_and_ask call can continue or end the SAME physical touch. ' +
      'Fails if a touch is already held - release_and_ask it first, or continue it with swipe_hold_and_ask.',
    inputSchema: {
      x: z.number().describe('X coordinate in device pixels.'),
      y: z.number().describe('Y coordinate in device pixels.'),
      question: z.string().describe('A short, specific question about the screen while holding.'),
      waitMs: z.number().optional().describe('Milliseconds to wait after pressing down before screenshotting (default 500).'),
    },
  },
  async ({ x, y, question, waitMs }) => {
    await adb.touchDown(x, y);
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'swipe_hold_and_ask',
  {
    title: 'Drag/continue-drag + HOLD at the end + screenshot + ask',
    description:
      'Drag from (x1, y1) to (x2, y2) over durationMs and HOLD at the end - no UP is sent, the finger stays down - wait ' +
      'briefly, take a screenshot, and ask a short question about the result. This is the composable building block for ' +
      'multi-step drag gestures: if a touch is ALREADY held (from a previous swipe_hold_and_ask or hold_and_ask call in ' +
      'this session), x1/y1 are ignored and the drag continues from wherever that touch currently is - the app sees one ' +
      'unbroken finger-down stream across both tool calls, not a new tap. If nothing is held, x1/y1 are required and this ' +
      'starts a fresh touch. Chain calls to this tool (optionally ending with release_and_ask) to test multi-leg drag ' +
      'gestures a single swipe_and_ask cannot express, e.g. "drag piece toward a drop zone, hesitate over it, then drag ' +
      'further to a different zone before releasing."',
    inputSchema: {
      x1: z.number().optional().describe('Start X - required only if no touch is currently held (see description).'),
      y1: z.number().optional().describe('Start Y - required only if no touch is currently held.'),
      x2: z.number().describe('End X - where the touch will be held after this call.'),
      y2: z.number().describe('End Y - where the touch will be held after this call.'),
      durationMs: z.number().optional().describe('Drag duration in ms (default 300).'),
      question: z.string().describe('A short, specific question about the screen while holding at (x2, y2).'),
      waitMs: z.number().optional().describe('Milliseconds to wait after reaching (x2, y2) before screenshotting (default 500).'),
    },
  },
  async ({ x1, y1, x2, y2, durationMs, question, waitMs }) => {
    if (adb.isHeld()) {
      await adb.continueDrag(x2, y2, durationMs ?? 300, /* release */ false);
    } else {
      if (x1 === undefined || y1 === undefined) {
        throw new Error('swipe_hold_and_ask: no touch is currently held, so x1 and y1 are required to start one.');
      }
      await adb.drag(x1, y1, x2, y2, durationMs ?? 300, /* release */ false);
    }
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'release_and_ask',
  {
    title: 'Release the currently-held touch + screenshot + ask',
    description:
      'Send UP wherever the touch currently held by hold_and_ask or swipe_hold_and_ask is, ending that gesture, then wait ' +
      'briefly, take a screenshot, and ask a short question about the result (e.g. "did the piece snap into the slot?"). ' +
      'Fails with a clear error if nothing is currently held - this is the end of a hold/drag chain, not a standalone tool.',
    inputSchema: {
      question: z.string().describe('A short, specific question about the screen after releasing.'),
      waitMs: z.number().optional().describe('Milliseconds to wait after releasing before screenshotting (default 500).'),
    },
  },
  async ({ question, waitMs }) => {
    await adb.touchUp();
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

// --- No-vision-call primitives -------------------------------------------
//
// Every tool above bundles an action with a screenshot+vision-question round
// trip, which is the point for most calls (see "Why combined action+observe
// tools" at the top of this file) - but it's needlessly expensive for the
// tail end of a gesture you've already screenshotted enough of. The
// recurring case: `record_swipe_and_ask` or a `swipe_hold_and_ask` chain
// already answered what you needed mid-drag, and all that's left is to end
// the physical touch cleanly - `release_and_ask` would force one more paid
// vision call just to do that. These three primitives are the tap/hold/
// release actions with no screenshot and no vision call at all.

server.registerTool(
  'tap',
  {
    title: 'Tap (x, y) - no screenshot, no vision call',
    description:
      'A plain tap at (x, y): DOWN then UP, no screenshot and no vision call. Use this when you don\'t need to observe the ' +
      'result right now (e.g. dismissing something you already confirmed via a prior screenshot, or a setup tap before a ' +
      'sequence you\'ll check at the end) - use tap_and_ask instead when you need to see what happened.',
    inputSchema: {
      x: z.number().describe('X coordinate in device pixels.'),
      y: z.number().describe('Y coordinate in device pixels.'),
    },
  },
  async ({ x, y }) => {
    await adb.tap(x, y);
    return { content: [{ type: 'text', text: 'tapped' }] };
  }
);

server.registerTool(
  'hold',
  {
    title: 'Press down + hold - no screenshot, no vision call',
    description:
      'Press down at (x, y) and HOLD - no UP is sent, no screenshot, no vision call. The quiet counterpart to hold_and_ask: ' +
      'use this when you\'ll check the result with a separate screenshot_ask/record_swipe_and_ask call, or don\'t need to ' +
      'observe this particular step. Leaves the touch held for a following swipe_hold_and_ask/swipe_hold/release_and_ask/' +
      'release. Fails if a touch is already held - release it first, or continue it with swipe_hold.',
    inputSchema: {
      x: z.number().describe('X coordinate in device pixels.'),
      y: z.number().describe('Y coordinate in device pixels.'),
    },
  },
  async ({ x, y }) => {
    await adb.touchDown(x, y);
    return { content: [{ type: 'text', text: 'held' }] };
  }
);

server.registerTool(
  'swipe_hold',
  {
    title: 'Drag/continue-drag + hold at the end - no screenshot, no vision call',
    description:
      'The quiet counterpart to swipe_hold_and_ask: drag from (x1, y1) to (x2, y2) over durationMs and HOLD at the end - no ' +
      'UP is sent, no screenshot, no vision call. If a touch is ALREADY held, x1/y1 are ignored and the drag continues from ' +
      'wherever that touch currently is (same composability as swipe_hold_and_ask). Use this for legs of a multi-step ' +
      'gesture you don\'t need to look at, saving a paid vision call for the leg(s) that matter.',
    inputSchema: {
      x1: z.number().optional().describe('Start X - required only if no touch is currently held.'),
      y1: z.number().optional().describe('Start Y - required only if no touch is currently held.'),
      x2: z.number().describe('End X - where the touch will be held after this call.'),
      y2: z.number().describe('End Y - where the touch will be held after this call.'),
      durationMs: z.number().optional().describe('Drag duration in ms (default 300).'),
    },
  },
  async ({ x1, y1, x2, y2, durationMs }) => {
    if (adb.isHeld()) {
      await adb.continueDrag(x2, y2, durationMs ?? 300, /* release */ false);
    } else {
      if (x1 === undefined || y1 === undefined) {
        throw new Error('swipe_hold: no touch is currently held, so x1 and y1 are required to start one.');
      }
      await adb.drag(x1, y1, x2, y2, durationMs ?? 300, /* release */ false);
    }
    return { content: [{ type: 'text', text: 'held' }] };
  }
);

server.registerTool(
  'release',
  {
    title: 'Release the currently-held touch - no screenshot, no vision call',
    description:
      'Send UP wherever the touch currently held by hold/swipe_hold/hold_and_ask/swipe_hold_and_ask is - no screenshot, no ' +
      'vision call. Use this to cleanly end a gesture whose outcome you already confirmed with an earlier screenshot (e.g. ' +
      'after record_swipe_and_ask already answered what you needed mid-drag) instead of paying for release_and_ask\'s extra ' +
      'vision call. Fails with a clear error if nothing is currently held.',
    inputSchema: {},
  },
  async () => {
    await adb.touchUp();
    return { content: [{ type: 'text', text: 'released' }] };
  }
);

server.registerTool(
  'long_press_and_ask',
  {
    title: 'Long-press + screenshot + ask',
    description: 'Long-press at (x, y) for durationMs, wait briefly, take a screenshot, and ask a short question about the result.',
    inputSchema: {
      x: z.number(), y: z.number(),
      durationMs: z.number().optional().describe('Hold duration in ms (default 800).'),
      question: z.string(),
      waitMs: z.number().optional().describe('Milliseconds to wait after releasing before screenshotting (default 500).'),
    },
  },
  async ({ x, y, durationMs, question, waitMs }) => {
    await adb.longPress(x, y, durationMs ?? 800);
    await new Promise((r) => setTimeout(r, waitMs ?? 500));
    const result = await askAboutScreen(question);
    return { content: [{ type: 'text', text: formatAnswer(question, result) }] };
  }
);

server.registerTool(
  'record_and_ask',
  {
    title: 'Record a timed screenshot sequence + ask about each frame',
    description:
      'For checking an ANIMATION or any effect that plays out over time (e.g. "does the strength indicator pulse smoothly?", ' +
      '"does the XP label fly up and fade out?", "does the sprite return to its start position?"). Optionally performs one ' +
      'action first (tap or swipe, or neither), then takes `frameCount` screenshots spaced `intervalMs` apart, and asks the ' +
      'SAME short question about each frame separately (each frame gets its own vision call, with its frame number in the ' +
      'prompt) - returns one answer per frame in order. \n\n' +
      'Sequential single-frame calls were chosen over sending several frames in one request: Runware\'s imageCaption ' +
      'does accept an undocumented multi-image array, and it works fine for exactly 2 frames, but degrades noticeably at ' +
      '3+ (truncated/malformed answers in testing) - sequential calls are both more reliable and, per-frame, no more ' +
      'expensive. Keep frameCount modest (3-6) - each frame is a full separate vision call and cost scales linearly with it.',
    inputSchema: {
      action: z.enum(['none', 'tap', 'swipe']).describe('Action to perform before starting the capture sequence.'),
      x: z.number().optional().describe('Required for action=tap or action=swipe (swipe start x).'),
      y: z.number().optional().describe('Required for action=tap or action=swipe (swipe start y).'),
      x2: z.number().optional().describe('Required for action=swipe (end x).'),
      y2: z.number().optional().describe('Required for action=swipe (end y).'),
      frameCount: z.number().min(2).max(8).describe('How many screenshots to take, spaced intervalMs apart (2-8; keep modest, see description).'),
      intervalMs: z.number().describe('Milliseconds between each screenshot (i.e. the sampling interval of the sequence).'),
      waitMs: z.number().optional().describe('Milliseconds to wait after the action before the FIRST screenshot (default 500) - same meaning as waitMs in tap_and_ask/swipe_and_ask, separate from intervalMs which spaces out the frames after that.'),
      question: z.string().describe('The same short question asked about every captured frame (e.g. "Is the indicator visible? yes/no").'),
    },
  },
  async ({ action, x, y, x2, y2, frameCount, intervalMs, waitMs, question }) => {
    if (action === 'tap') {
      if (x === undefined || y === undefined) throw new Error('action=tap requires x and y.');
      await adb.tap(x, y);
    } else if (action === 'swipe') {
      if (x === undefined || y === undefined || x2 === undefined || y2 === undefined) {
        throw new Error('action=swipe requires x, y, x2, y2.');
      }
      await adb.swipe(x, y, x2, y2);
    }

    if (action !== 'none') {
      await new Promise((r) => setTimeout(r, waitMs ?? 500));
    }

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      frames.push(await adb.screenshotPng());
    }

    const answers = [];
    for (let i = 0; i < frames.length; i++) {
      const framedQuestion = `This is frame ${i + 1} of ${frameCount} in a timed sequence (${intervalMs}ms apart). ${question}`;
      const result = await askAboutImage(frames[i], framedQuestion);
      answers.push({ frame: i + 1, tMs: i * intervalMs, ...result });
    }

    const lines = answers.map((a) => `Frame ${a.frame} (t=${a.tMs}ms): ${a.text} (screenshot: ${a.screenshotPath})`);
    const totalCost = answers.reduce((sum, a) => sum + (a.costUsd || 0), 0);
    lines.push(`\n(sequence cost: $${totalCost.toFixed(4)}, today total: $${answers[answers.length - 1].todayTotal.toFixed(4)})`);
    const alerts = answers.filter((a) => a.alert).map((a) => `Frame ${a.frame}: ${a.alert}`);
    if (alerts.length) lines.push(`\n[COST ALERT]\n${alerts.join('\n')}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.registerTool(
  'record_swipe_and_ask',
  {
    title: 'Record a timed screenshot sequence DURING a swipe/drag + ask about each frame',
    description:
      'Like record_and_ask, but for watching what happens WHILE a drag is in flight rather than only before/after it - e.g. ' +
      '"does the dragged piece follow the finger smoothly?", "does a drop-zone highlight turn on partway through the drag, ' +
      'before the finger arrives?", "does anything visually lag or stutter mid-drag?". Starts a continuous drag from ' +
      '(x1, y1) to (x2, y2) over durationMs (same continuous-touch implementation as swipe_and_ask - see README "Drag/hold ' +
      'support"), and WHILE that drag is still running, captures `frameCount` screenshots spaced `intervalMs` apart - the ' +
      'sampling interval is independent of durationMs, so you can capture a coarser or finer timeline than the drag\'s own ' +
      'MOVE cadence. If frameCount*intervalMs exceeds durationMs, the drag finishes early and the remaining frames capture ' +
      'the held/released end state rather than genuine mid-drag frames - keep frameCount*intervalMs at or below durationMs ' +
      'if you specifically need every frame to be mid-gesture. Ends with release (UP) at (x2, y2) unless holdAtEnd is true, ' +
      'in which case the touch is left down afterward for a following swipe_hold_and_ask/release_and_ask to continue or end.',
    inputSchema: {
      x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
      durationMs: z.number().describe('Total drag duration in ms - frames are captured while this is still in progress.'),
      frameCount: z.number().min(2).max(8).describe('How many screenshots to take during the drag, spaced intervalMs apart (2-8).'),
      intervalMs: z.number().describe('Milliseconds between each screenshot (independent of durationMs - see description).'),
      holdAtEnd: z.boolean().optional().describe('If true, leave the touch held at (x2, y2) instead of releasing (default false).'),
      question: z.string().describe('The same short question asked about every captured frame.'),
    },
  },
  async ({ x1, y1, x2, y2, durationMs, frameCount, intervalMs, holdAtEnd, question }) => {
    if (adb.isHeld()) {
      throw new Error('record_swipe_and_ask: a touch is already held - release it first (release_and_ask) or this would be read as a second finger, not this drag\'s start.');
    }

    // Fire the drag and the frame-capture loop concurrently - the whole point
    // of this tool is sampling screenshots WHILE the drag is in flight, not
    // before/after it like record_and_ask's action+then-record shape.
    const dragPromise = adb.drag(x1, y1, x2, y2, durationMs, /* release */ !holdAtEnd);

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      frames.push(await adb.screenshotPng());
    }

    await dragPromise; // make sure the drag (and its release/hold) has actually finished before returning

    const answers = [];
    for (let i = 0; i < frames.length; i++) {
      const framedQuestion = `This is frame ${i + 1} of ${frameCount}, captured ${i * intervalMs}ms into a ${durationMs}ms drag from (${x1},${y1}) to (${x2},${y2}). ${question}`;
      const result = await askAboutImage(frames[i], framedQuestion);
      answers.push({ frame: i + 1, tMs: i * intervalMs, ...result });
    }

    const lines = answers.map((a) => `Frame ${a.frame} (t=${a.tMs}ms): ${a.text} (screenshot: ${a.screenshotPath})`);
    const totalCost = answers.reduce((sum, a) => sum + (a.costUsd || 0), 0);
    lines.push(`\n(sequence cost: $${totalCost.toFixed(4)}, today total: $${answers[answers.length - 1].todayTotal.toFixed(4)})`);
    const alerts = answers.filter((a) => a.alert).map((a) => `Frame ${a.frame}: ${a.alert}`);
    if (alerts.length) lines.push(`\n[COST ALERT]\n${alerts.join('\n')}`);
    if (holdAtEnd) lines.push('\n(touch held at end point - call swipe_hold_and_ask or release_and_ask next)');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.registerTool(
  'type_text',
  {
    title: 'Type text',
    description: 'Type text into whatever field currently has focus. No screenshot/vision call - pair with screenshot_ask if you need to confirm the result.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => {
    await adb.text(text);
    return { content: [{ type: 'text', text: 'typed' }] };
  }
);

server.registerTool(
  'press_key',
  {
    title: 'Press hardware/virtual key',
    description: 'Send an Android keyevent code (e.g. 4 = BACK, 66 = ENTER, 187 = APP_SWITCH). No vision call.',
    inputSchema: { keycode: z.number().describe('Android KEYCODE_* integer value.') },
  },
  async ({ keycode }) => {
    await adb.keyevent(keycode);
    return { content: [{ type: 'text', text: 'pressed' }] };
  }
);

server.registerTool(
  'logcat_grep',
  {
    title: 'Read recent logcat, filtered',
    description:
      'Read the last N logcat lines, optionally filtered by a regex (e.g. your app\'s tag, or "Exception|FATAL"). ' +
      'No vision call, no cost - prefer this over screenshot_ask whenever what you need is already in a log line ' +
      '(crashes, your own debug prints, network errors).',
    inputSchema: {
      lines: z.number().optional().describe('How many recent lines to fetch (default 200).'),
      filterRegex: z.string().optional().describe('Optional regex; only matching lines are returned.'),
    },
  },
  async ({ lines, filterRegex }) => {
    const text = await adb.logcatRecent(lines ?? 200, filterRegex);
    return { content: [{ type: 'text', text: text || '(no matching lines)' }] };
  }
);

server.registerTool(
  'vision_spend_report',
  {
    title: 'Report today\'s vision spend',
    description: 'Report the cumulative vision-provider spend for today and the configured alert/cap thresholds, without making any device or vision call.',
    inputSchema: {},
  },
  async () => {
    const spent = costTracker.todaySpend();
    const text =
      `Today's vision spend: $${spent.toFixed(4)}\n` +
      `Alert threshold (per call): $${costTracker.ALERT_USD.toFixed(4)}\n` +
      `Session cap (per day): $${costTracker.SESSION_CAP_USD.toFixed(4)}\n` +
      `Log file: ${costTracker.LOG_PATH}`;
    return { content: [{ type: 'text', text }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`mobile-mcp-opengl fatal: ${err.stack || err}\n`);
  process.exit(1);
});
