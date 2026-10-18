#!/usr/bin/env node
// 同期済み nightly-batch から起動。kim-PC のみで検出→未評価の採点→提案を完了する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { userHome, readConfig } from './lib/eval-config.mjs';
import { frontierLimit, proposeSavedEvaluations } from './model-scout.mjs';
import { isEntry } from './is-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function evaluations(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export function unevaluatedScoutModels(pending, config, rows, { max = frontierLimit() } = {}) {
  // 「評価済み」は計測が1件でも取れたか（graded>0）だけで判定する。切捨て（truncated）多発は
  // モデルの品質であって未評価ではなく、計測の安定性は提案側（aggregateMeasurements）が独自に弾く。
  // 従来の「error+truncated が1割超は未評価」では、切捨てしがちな候補を毎晩再評価して
  // 日次処理を恒久的に失敗させていた（2026-10-16 実測: qwen/qwen3.7-flash は8月から5回、
  // inclusionai/ling-3.0-flash は4回、いずれも基準を永遠に満たさない）。
  const evaluated = new Set(rows.filter(r => r.provider === 'openrouter' && (r.graded || 0) > 0).map(r => r.model));
  const enabled = new Set(config.filter(x => x.provider === 'openrouter' && !x.skip).map(x => x.model));
  return [...new Map(pending.map(x => [x.id, x])).values()]
    .filter(x => enabled.has(x.id) && !evaluated.has(x.id))
    .sort((a, b) => Number(b.tier === 'frontier') - Number(a.tier === 'frontier') || (b.created || 0) - (a.created || 0))
    .slice(0, max);
}
// 全滅（graded=0）1回だけでは一時障害と区別できないため、近期間内に2回全滅した候補は再試行を
// 打ち切る（1回目は翌日もう一度だけ試す）。打ち切りは状態を持たず eval-results の実績だけで決める。
export function unmeasuredGiveUpIds(rows, { now = new Date(), days = 14, limit = 2 } = {}) {
  const cutoff = now.getTime() - days * 86400000;
  const counts = new Map();
  for (const row of rows) {
    if (row.provider !== 'openrouter' || (row.graded || 0) > 0) continue;
    const at = Date.parse(row.t);
    if (Number.isFinite(at) && at < cutoff) continue;
    counts.set(row.model, (counts.get(row.model) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= limit).map(([id]) => id));
}
export async function runDailyScout({ home = process.env.ORGIAST_HOME || userHome(), now = new Date(),
  label, spawnImpl = spawnSync, propose = proposeSavedEvaluations, max = frontierLimit(), log = console.log } = {}) {
  // auto-progress-digest と同じ1台限定判定。未設定・未知のPCでは実行しない。
  if ((label ?? resolveFleetLabel(home)) !== 'kim-PC') return { ok: true, skipped: 'not-kim-pc' };
  const dir = path.join(home, '.claude'), logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const record = message => { fs.appendFileSync(path.join(logs, 'model-scout.log'), `${new Date().toISOString()} ${message}\n`); log(message); };
  const lock = path.join(dir, 'model-scout-daily.lock'), dailyFile = path.join(dir, 'model-scout-daily.json');
  let owned = false;
  try {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); owned = true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid lock');
      try { process.kill(pid, 0); return { ok: true, skipped: 'running' }; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); owned = true;
    }
    const previous = readJson(dailyFile, null);
    if (previous?.completedAt?.slice(0, 10) === now.toISOString().slice(0, 10)) return { ok: true, skipped: 'already-completed' };
    const stateFile = path.join(dir, 'model-scout-state.json');
    const before = readJson(stateFile, null)?.updatedAt;
    const run = args => spawnImpl(process.execPath, args, { cwd: path.dirname(HERE), encoding: 'utf8',
      timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, USERPROFILE: home, ORGIAST_HOME: home } });
    record('model-scout 開始');
    const scout = run([path.join(HERE, 'model-scout.mjs'), '--once']);
    const state = readJson(stateFile, null);
    // scout の従来CLIは障害でも exit 0。保存成功を確認して沈黙失敗を検出する。
    if (scout.error || scout.status !== 0 || !state?.updatedAt || state.updatedAt === before) throw new Error('scout failed');
    const resultsFile = path.join(dir, 'eval-results.jsonl');
    const configFile = path.join(dir, 'eval', 'providers.local.json');
    const pending = state.pendingCandidates || [];
    const rows = evaluations(resultsFile);
    const giveUps = unmeasuredGiveUpIds(rows, { now });
    const live = pending.filter(x => !giveUps.has(x.id));
    if (live.length < pending.length) {
      record(`model-scout 再試行打ち切り（近期間に計測不能2回）: ${pending.filter(x => giveUps.has(x.id)).map(x => x.id.replace(/[\r\n\t]/g, ' ')).join(', ')}`);
    }
    const targets = unevaluatedScoutModels(live, readConfig({ overlayFile: configFile }), rows, { max });
    let failed = false;
    for (const candidate of targets) {
      const result = run([path.join(HERE, 'eval-harness.mjs'), '--provider', 'openrouter', '--model', candidate.id]);
      const rowsAfter = evaluations(resultsFile);
      const remaining = unevaluatedScoutModels([candidate], readConfig({ overlayFile: configFile }), rowsAfter, { max: 1 });
      const candidateClean = candidate.id.replace(/[\r\n\t]/g, ' ');
      if (result.error || result.status !== 0 || (remaining.length && !unmeasuredGiveUpIds(rowsAfter, { now }).has(candidate.id))) {
        failed = true;
        record(`model-scout error: 未評価候補を次回へ繰越 (${candidateClean})`);
      } else if (remaining.length) record(`model-scout 評価打ち切り（計測不能2回）: ${candidateClean}`);
      else record(`model-scout eval 完了: ${candidateClean}`);
    }
    await propose({ home, resultsFile, configFile, log: record });
    if (failed) throw new Error('未評価候補が残ったため未完了（次回1回だけ再試行）');
    const temp = `${dailyFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ completedAt: now.toISOString(), evaluated: targets.length }) + '\n');
    fs.renameSync(temp, dailyFile);
    record(`model-scout 完了: 評価 ${targets.length} 件`);
    return { ok: true, evaluated: targets.length };
  } catch (e) {
    const reason = String(e?.message ?? e).replace(/[\r\n\t]/g, ' ').slice(0, 200);
    record(`model-scout error: 日次処理失敗（${reason}）。次回再試行`);
    return { ok: false };
  } finally { if (owned) fs.rmSync(lock, { force: true }); }
}
if (isEntry(import.meta.url)) process.exitCode = (await runDailyScout()).ok ? 0 : 1;
