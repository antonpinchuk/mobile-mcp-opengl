// Persists every screenshot a vision call actually looked at, so both the
// calling agent and the human can go look at the same pixels the model saw -
// the model's text answer is not always trustworthy (see README "Vision
// provider accuracy"), and a saved file is often the fastest way to tell
// whether a wrong-looking answer was a model mistake or a real bug.
//
// Files land in .data/screenshots/ (gitignored - see .gitignore) named by
// timestamp so a directory listing is already sorted chronologically. This
// directory is NOT cleaned up automatically - it is the user's to clear
// (`rm -rf .data/screenshots` or delete individual files) once a session's
// screenshots are no longer needed. There is no size/age cap: for a
// screenshot-heavy QA session this can add up, so clearing it periodically
// is a manual, deliberate action, not something this server does for you.

const fs = require('fs');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, '..', '.data', 'screenshots');

function ensureDir() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Timestamp-based filename, collision-safe within the same millisecond via a
// monotonic counter (a tight loop - e.g. record_and_ask's per-frame saves -
// can otherwise produce two screenshots in the same millisecond).
let lastMs = 0;
let counter = 0;
function timestampName() {
  const now = Date.now();
  if (now === lastMs) {
    counter += 1;
  } else {
    lastMs = now;
    counter = 0;
  }
  const iso = new Date(now).toISOString().replace(/[:.]/g, '-'); // filesystem-safe
  return counter > 0 ? `${iso}-${counter}.png` : `${iso}.png`;
}

// Saves a screenshot PNG buffer and returns its absolute path. Call this
// once per screenshot actually shown to the vision model, right where that
// screenshot is captured/used - see server.js askAboutImage().
function save(pngBuffer) {
  ensureDir();
  const filePath = path.join(SCREENSHOT_DIR, timestampName());
  fs.writeFileSync(filePath, pngBuffer);
  return filePath;
}

module.exports = { save, SCREENSHOT_DIR };
