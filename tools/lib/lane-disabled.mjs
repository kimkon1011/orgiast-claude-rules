// PC ごとにレーンを無効化する（~/.claude/lanes-disabled.json）。
// 課金切れや回数制限には使わない。それらは provider-cooldown で一時退避し、ヘルスチェックで回復したら自動で戻す。
// gemini を無効にすると gemini-cli（同じ GEMINI_API_KEY を使う）も無効になる。
// 無効レーンは通常のルーティング候補から外し、lane-doctor は自動停止を実測する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const isAutoDisabled = entry => ['failure_rate', 'quality_validation'].includes(entry?.reason);
export const TEMP_DISABLE_MS = 6 * 60 * 60 * 1000;
export function disabledLanesFile(home = process.env.ORGIAST_HOME || os.homedir()) { return path.join(home, '.claude', 'lanes-disabled.json'); }
// probe で復帰させた時刻を記録する（~/.claude/lanes-restored.json）。
// fallback-backend-health の unhealthyCandidates が「復帰より前の失敗」を数えて
// 直後に再停止するのを防ぐためのマーカー（2026-11-28 05:08 実測の再発）。
export function restoredLanesFile(home = process.env.ORGIAST_HOME || os.homedir()) { return path.join(home, '.claude', 'lanes-restored.json'); }
// { "<name>": <epoch ms>, ... }（name は小文字）。無い・壊れていたら {}。
export function readRestoredAt(home = process.env.ORGIAST_HOME || os.homedir(), file = restoredLanesFile(home)) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
    if (typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      const name = String(key).trim().toLowerCase();
      const t = Number(value);
      if (!name || !Number.isFinite(t)) continue;
      out[name] = t;
    }
    return out;
  } catch { return {}; }
}
export function readDisabledEntries(home = process.env.ORGIAST_HOME || os.homedir(), file = disabledLanesFile(home)) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
    if (Array.isArray(data)) return Object.fromEntries(data.filter(Boolean).map(n => [String(n).trim().toLowerCase(), { reason: 'manual' }]));
    if (typeof data !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      const name = String(key).trim().toLowerCase();
      if (!name) continue;
      out[name] = value && typeof value === 'object' && !Array.isArray(value) ? value : { reason: 'manual' };
    }
    return out;
  } catch { return {}; }
}
export function disabledLanes(home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), entries = readDisabledEntries(home)) {
  const set = new Set();
  for (const [name, entry] of Object.entries(entries)) {
    const until = Number(entry?.until);
    // until が過去の一時停止は無効として扱わない。restoreExpiredDisabledLanes の
    // probe を待たずに期限切れを外す。
    if (Number.isFinite(until) && until <= now) continue;
    set.add(name);
  }
  if (set.has('gemini')) set.add('gemini-cli');
  if (set.has('openrouter')) { set.add('openrouter-free'); set.add('openrouter-code'); }
  return set;
}
function writeDisabledEntries(home, data) {
  const file = disabledLanesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); try { fs.unlinkSync(tmp); } catch {} }
}
// lanes-restored.json も lanes-disabled.json と同じ tmp→rename 方式で書く。
function writeRestoredAt(home, data) {
  const file = restoredLanesFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); try { fs.unlinkSync(tmp); } catch {} }
}
// 健康判定による停止は必ず until 付き（+6h）。until の無い手動エントリは上書きしない。恒久停止は書かない。
export function disableLanesTemporarily(home, hits, now = Date.now()) {
  if (!hits?.length) return [];
  const data = readDisabledEntries(home);
  const until = now + TEMP_DISABLE_MS;
  const written = [];
  for (const hit of hits) {
    const name = String(hit?.name || '').trim().toLowerCase();
    if (!name) continue;
    if (name === 'cursor-agent') continue;
    const existing = data[name];
    const manual = existing && !Number.isFinite(Number(existing.until)) && existing.reason !== 'health' && !isAutoDisabled(existing);
    if (manual) continue;
    data[name] = { reason: hit.reason || 'health', until, at: new Date(now).toISOString(), ...(hit.calls != null ? { calls: hit.calls } : {}), ...(hit.failures != null ? { failures: hit.failures } : {}) };
    written.push(name);
  }
  if (written.length) writeDisabledEntries(home, data);
  return written;
}
const PROBE_OF = {
  gemini: 'gemini', 'gemini-cli': 'gemini', openrouter: 'openrouter', 'openrouter-free': 'openrouter', 'openrouter-code': 'openrouter',
  qwen: 'deepseek', deepseek: 'deepseek', 'cheap-code:deepseek': 'deepseek', glm: 'glm', 'cheap-code:glm': 'glm', groq: 'groq',
};
// 自動停止は生存を実測したら解除する。他の期限付き停止は期限到来後に従来の復帰判定を行う。
export function restoreExpiredDisabledLanes(health, home, now = Date.now(), recovered) {
  const data = readDisabledEntries(home);
  if (!Object.keys(data).length) return [];
  const restored = [];
  let changed = false;
  for (const [name, entry] of Object.entries(data)) {
    const until = Number(entry?.until);
    const provider = PROBE_OF[name] || name;
    const autoRecovery = recovered && isAutoDisabled(entry);
    if (autoRecovery ? !recovered.has(provider) : !Number.isFinite(until) || until > now) continue;
    const lane = health?.lanes?.[provider];
    if (autoRecovery || lane?.alive === true) {
      delete data[name];
      restored.push(name);
      changed = true;
      continue;
    }
    if (lane && lane.alive === false && !['disabled', 'disabled:expired', 'missing_key'].includes(lane.reason)) {
      data[name] = { ...entry, until: now + TEMP_DISABLE_MS, at: new Date(now).toISOString(), reason: entry.reason || 'health' };
      changed = true;
    }
  }
  if (changed) writeDisabledEntries(home, data);
  // 復帰したレーンは古い失敗で再停止されないよう、復帰時刻を記録する。
  if (restored.length) {
    const restoredAt = readRestoredAt(home);
    for (const name of restored) restoredAt[name.trim().toLowerCase()] = now;
    writeRestoredAt(home, restoredAt);
  }
  if (health && restored.length) {
    health.repairs = health.repairs || [];
    for (const name of restored) health.repairs.push({ provider: name, action: 'disabled_restored', detail: 'probe_ok' });
  }
  return restored;
}
