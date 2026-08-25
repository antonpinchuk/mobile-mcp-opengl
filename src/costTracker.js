// Spend tracking + guardrails, provider-agnostic (works off whatever costUsd
// a provider reports; if a provider can't report cost, entries are logged
// with costUsd: null and never trigger the alert/cap - the cap silently
// can't protect you in that case, which is a limitation worth knowing about
// rather than hiding).

const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.VISION_LOG_PATH || path.join(process.cwd(), '.vision-log.jsonl');
const ALERT_USD = parseFloat(process.env.VISION_ALERT_USD || '0.0015');
const SESSION_CAP_USD = parseFloat(process.env.VISION_SESSION_CAP_USD || '2.00');

function todaySpend() {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  let total = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp && entry.timestamp.slice(0, 10) === today && typeof entry.costUsd === 'number') {
        total += entry.costUsd;
      }
    } catch (_) { /* skip malformed lines */ }
  }
  return total;
}

function assertUnderCap() {
  const spent = todaySpend();
  if (spent >= SESSION_CAP_USD) {
    throw new Error(
      `Vision spend cap reached: $${spent.toFixed(4)} >= $${SESSION_CAP_USD.toFixed(4)} (VISION_SESSION_CAP_USD). ` +
      `Refusing to make another call - raise the cap explicitly if this is expected.`
    );
  }
}

function record({ question, answer, costUsd }) {
  const entry = { timestamp: new Date().toISOString(), question, answer, costUsd };
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');

  let alert = null;
  if (typeof costUsd === 'number' && costUsd > ALERT_USD) {
    alert =
      `Call cost $${costUsd.toFixed(4)} exceeds threshold $${ALERT_USD.toFixed(4)}. ` +
      `The model likely returned a long answer (response length drives cost far more than image ` +
      `size for most vision providers - see README "Cost model"). Reformulate the question to force ` +
      `a shorter answer (yes/no, a number, a tiny JSON) instead of accepting this as normal.`;
  }
  return { entry, alert, todayTotal: todaySpend() };
}

module.exports = { todaySpend, assertUnderCap, record, ALERT_USD, SESSION_CAP_USD, LOG_PATH };
