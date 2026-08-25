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
  const result = await provider.ask(png, 'image/png', question + SHORT_ANSWER_SUFFIX);
  const { alert, todayTotal } = costTracker.record({ question, answer: result.text, costUsd: result.costUsd });
  return { ...result, alert, todayTotal };
}

async function askAboutScreen(question) {
  const png = await adb.screenshotPng();
  return askAboutImage(png, question);
}

function formatAnswer(question, result) {
  const parts = [result.text];
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
      'question about the result - all in one call.',
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

    const lines = answers.map((a) => `Frame ${a.frame} (t=${a.tMs}ms): ${a.text}`);
    const totalCost = answers.reduce((sum, a) => sum + (a.costUsd || 0), 0);
    lines.push(`\n(sequence cost: $${totalCost.toFixed(4)}, today total: $${answers[answers.length - 1].todayTotal.toFixed(4)})`);
    const alerts = answers.filter((a) => a.alert).map((a) => `Frame ${a.frame}: ${a.alert}`);
    if (alerts.length) lines.push(`\n[COST ALERT]\n${alerts.join('\n')}`);

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
