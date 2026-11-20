// PC ごとにレーンを無効化する（~/.claude/lanes-disabled.json）。
// 課金切れや回数制限には使わない。それらは provider-cooldown で一時退避し、ヘルスチェックで回復したら自動で戻す。
// gemini を無効にすると gemini-cli（同じ GEMINI_API_KEY を使う）も無効になる。
// 無効レーンは lane-doctor が probe せず alive=false/reason=disabled とし、codex-do と llm-fallback の候補から外す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const TEMP_DISABLE_MS = 6 * 60 * 60 * 1000;
export function disabledLanesFile(home = process.env.ORGIAST_HOME || os.homedir()) { return path.join(home, '.claude', 'lanes-disabled.json'); }
export function readDisabledEntries(home = process.env.ORGIAST_HOME || os.homedir()) {
  try {
    const data = JSON.parse(fs.readFileSync(disabledLanesFile(home), 'utf8').replace(/^\uFEFF/, '')) || {};
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
export function disabledLanes(home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now()) {
  const set = new Set();
  for (const [name, entry] of Object.entries(readDisabledEntries(home))) {
    const until = Number(entry?.until);
    // until が過去の一時停止は無効として扱わない。restoreExpiredDisabledLanes の
    // probe を待たずに期限切れを外す（cursor-agent は lane-doctor の PROBE_OF に
    // 無く、期限切れのまま永遠に候補から外れる実害があった。2026-11-20 000/011）。
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
// 健康判定による停止は必ず until 付き（+6h）。until の無い手動エントリは上書きしない。恒久停止は書かない。
export function disableLanesTemporarily(home, hits, now = Date.now()) {
  if (!hits?.length) return [];
  const data = readDisabledEntries(home);
  const until = now + TEMP_DISABLE_MS;
  const written = [];
  for (const hit of hits) {
    const name = String(hit?.name || '').trim().toLowerCase();
    if (!name) continue;
    const existing = data[name];
    const manual = existing && !Number.isFinite(Number(existing.until)) && !['health', 'failure_rate', 'quality_validation'].includes(existing.reason);
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
  'cursor-agent': 'cursor-agent',
};
// until を過ぎた一時停止だけを見る。生存 probe なら削除して復帰、失敗なら until を +6h に伸ばす。until 無しは触らない。
export function restoreExpiredDisabledLanes(health, home, now = Date.now()) {
  const data = readDisabledEntries(home);
  if (!Object.keys(data).length) return [];
  const restored = [];
  let changed = false;
  for (const [name, entry] of Object.entries(data)) {
    const until = Number(entry?.until);
    if (!Number.isFinite(until) || until > now) continue;
    const lane = health?.lanes?.[PROBE_OF[name] || name];
    if (lane?.alive === true) {
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
  if (health && restored.length) {
    health.repairs = health.repairs || [];
    for (const name of restored) health.repairs.push({ provider: name, action: 'disabled_restored', detail: 'probe_ok' });
  }
  return restored;
}
