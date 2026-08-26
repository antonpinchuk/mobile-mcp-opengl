// Thin wrapper around the adb CLI. No dependency on any specific Android
// SDK path beyond `adb` being on PATH (or ADB_PATH set in .env).

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ADB = process.env.ADB_PATH || 'adb';

function deviceArgs() {
  const serial = process.env.ADB_DEVICE_SERIAL;
  return serial ? ['-s', serial] : [];
}

async function run(args) {
  const { stdout } = await execFileAsync(ADB, [...deviceArgs(), ...args], {
    maxBuffer: 1024 * 1024 * 64, // screenshots can be a few MB
    encoding: 'buffer',
  });
  return stdout;
}

async function screenshotPng() {
  // exec-out streams the raw PNG straight back over stdout - no temp file on
  // the device, no pull step.
  return run(['exec-out', 'screencap', '-p']);
}

async function tap(x, y) {
  await run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

// --- Continuous touch (real drag/hold support) ---------------------------
//
// `adb shell input swipe`/`draganddrop` are single shell commands that the
// framework turns into a synthetic gesture internally - on at least one
// tested Cocos2d-x app with a custom EventListenerTouchOneByOne-based drag
// handler, that synthetic gesture was never recognized as a real drag (see
// README "Drag/hold support" for what "recognized" means and how this was
// tested). The fix implemented here is to drive the SAME low-level
// `input touchscreen motionevent DOWN/MOVE/UP` primitives that a real finger
// produces, but from a single JS-side timer loop within one async function
// call, so the MOVE cadence and total duration are under our control instead
// of being whatever a hand-rolled shell loop's process-spawn overhead
// happens to produce. Each motionevent is still its own `adb shell` exec
// (there's no batched-injection subcommand exposed by `adb shell input`),
// but pacing them by wall-clock target time (see below) keeps the gesture's
// timing close to the requested durationMs regardless of per-call exec
// latency.
//
// MOVE_STEP_MS is the target spacing between MOVE events. 15-30ms (33-66Hz)
// covers typical real-touchscreen sampling rates; below ~15ms, adb exec
// latency (measured here at roughly 10-25ms per `adb shell` invocation on a
// local emulator) starts to dominate and you just get fewer, unevenly-spaced
// steps for the trouble. It's exported so callers needing a different
// tradeoff (e.g. a very short, very smooth drag) can override it.
const MOVE_STEP_MS = 20;

// Module-level (not persisted - see README "Drag/hold composability") state
// for "is there a currently-held touch, and where". This process is a single
// long-lived stdio MCP server per session, so a plain in-memory variable is
// sufficient: it does not need to survive a process restart or be shared
// across sessions, and a fresh process naturally starts with no held touch.
let heldTouch = null; // { x, y } in device pixels, or null when nothing is down

function isHeld() {
  return heldTouch !== null;
}

function heldPoint() {
  return heldTouch ? { ...heldTouch } : null;
}

async function motionEvent(action, x, y) {
  await run(['shell', 'input', 'touchscreen', 'motionevent', action, String(Math.round(x)), String(Math.round(y))]);
}

// Moves from (x1,y1) to (x2,y2) over durationMs, issuing MOVE events roughly
// every stepMs (see MOVE_STEP_MS above), paced against wall-clock time so
// slow individual adb calls don't accumulate into a much-longer-than-
// requested gesture. Does NOT issue DOWN or UP - callers compose this with
// touchDown/touchUp/touchRelease below depending on whether the gesture
// should start fresh, end with a release, or end still held.
async function moveTo(x1, y1, x2, y2, durationMs, stepMs = MOVE_STEP_MS) {
  const steps = Math.max(1, Math.round(durationMs / stepMs));
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const frac = i / steps;
    const x = x1 + (x2 - x1) * frac;
    const y = y1 + (y2 - y1) * frac;
    const targetT = t0 + frac * durationMs;
    const wait = targetT - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await motionEvent('MOVE', x, y);
  }
}

// Starts a new touch at (x, y) - a fresh DOWN. Throws if a touch is already
// held, since sending a second DOWN without releasing the first would be
// misread by the app as a second finger, not a continuation.
async function touchDown(x, y) {
  if (isHeld()) {
    throw new Error(`touchDown: a touch is already held at (${heldTouch.x}, ${heldTouch.y}) - release or continue it instead of starting a new one.`);
  }
  await motionEvent('DOWN', x, y);
  heldTouch = { x, y };
}

// Releases the currently-held touch (UP at its current position). Throws if
// nothing is held - see README "Drag/hold composability" for why this is a
// hard error rather than a silent no-op.
async function touchUp() {
  if (!isHeld()) {
    throw new Error('touchUp: no touch is currently held - nothing to release.');
  }
  await motionEvent('UP', heldTouch.x, heldTouch.y);
  heldTouch = null;
}

// One continuous gesture: DOWN at (x1,y1), MOVE-interpolate to (x2,y2) over
// durationMs, then either UP (release=true) or leave the touch down at
// (x2,y2) (release=false, e.g. for swipe_hold_and_ask). Requires nothing to
// already be held - use continueDrag below to extend an existing hold.
async function drag(x1, y1, x2, y2, durationMs, release, stepMs) {
  await touchDown(x1, y1);
  await moveTo(x1, y1, x2, y2, durationMs, stepMs);
  if (release) {
    await touchUp();
  } else {
    heldTouch = { x: x2, y: y2 };
  }
}

// Continues an ALREADY-held touch onward to (x2, y2) - no new DOWN, so the
// app sees one unbroken finger-down stream from wherever the previous
// hold/drag left off. Throws if nothing is currently held (see README).
async function continueDrag(x2, y2, durationMs, release, stepMs) {
  if (!isHeld()) {
    throw new Error('continueDrag: no touch is currently held - call a tool that starts a hold (swipe_hold_and_ask or hold_and_ask) first.');
  }
  const { x: x1, y: y1 } = heldTouch;
  await moveTo(x1, y1, x2, y2, durationMs, stepMs);
  if (release) {
    await touchUp();
  } else {
    heldTouch = { x: x2, y: y2 };
  }
}

// Legacy single-shot swipe kept only as a low-level building block name for
// compatibility; swipe_and_ask/record_and_ask now use drag() above (see
// server.js) so they get the same real continuous-touch behavior as the new
// hold/drag tools instead of the old single `adb shell input swipe` call.
async function swipe(x1, y1, x2, y2, durationMs = 300) {
  await drag(x1, y1, x2, y2, durationMs, /* release */ true);
}

async function longPress(x, y, durationMs = 800) {
  // A "long press" on a single point is a zero-distance swipe held for
  // durationMs - `input swipe` with identical start/end coordinates is the
  // standard adb idiom for this, there's no separate long-press subcommand.
  await swipe(x, y, x, y, durationMs);
}

async function keyevent(code) {
  await run(['shell', 'input', 'keyevent', String(code)]);
}

async function text(input) {
  // adb's `input text` chokes on raw spaces - it needs %s.
  const escaped = String(input).replace(/ /g, '%s');
  await run(['shell', 'input', 'text', escaped]);
}

async function logcatRecent(lines = 200, filterRegex) {
  const out = await run(['logcat', '-d', '-t', String(lines)]);
  const text = out.toString('utf8');
  if (!filterRegex) return text;
  const re = new RegExp(filterRegex);
  return text.split('\n').filter((line) => re.test(line)).join('\n');
}

module.exports = {
  screenshotPng, tap, swipe, longPress, keyevent, text, logcatRecent,
  // Continuous touch / hold primitives (see "Continuous touch" section above).
  touchDown, touchUp, drag, continueDrag, isHeld, heldPoint, MOVE_STEP_MS,
};
