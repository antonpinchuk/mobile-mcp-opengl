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

async function swipe(x1, y1, x2, y2, durationMs = 300) {
  await run(['shell', 'input', 'swipe', String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))]);
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

module.exports = { screenshotPng, tap, swipe, longPress, keyevent, text, logcatRecent };
