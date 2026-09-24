// Shared state reader; tools/lib and VSIX copies must stay byte-identical.
const fs = require('node:fs');
const path = require('node:path');

function targetCount(value = 1) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('待機数は 1..10 の整数で指定してください');
  return count;
}
function readConfig(home, env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return targetCount(env.CLAUDE_MOBILE_STANDBY ?? config.count ?? 1);
}
function readSnapshot(home, now = Date.now()) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), 'utf8'));
    if (now - state.updatedAt > 30000 || now < state.updatedAt || !Number.isInteger(state.waiting) || state.waiting < 0) return null;
    return state;
  } catch { return null; }
}
module.exports = { targetCount, readConfig, readSnapshot };
