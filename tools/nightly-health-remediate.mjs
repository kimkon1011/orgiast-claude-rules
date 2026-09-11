#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { redactAll } from './lib/redact.mjs';
import { notifyKim } from './notify-kim.mjs';
import { addDecision } from './pending-decisions.mjs';
import { appendLineWithRetry } from './lib/append-line.mjs';
import { getScheduledTaskInfo, startScheduledTask, stopScheduledTask } from './lib/scheduled-task.mjs';
import { playbooks as defaultPlaybooks } from './lib/remediate-playbooks/index.mjs';

const DAY = 86400000;
export function normalizeMessage(value) { return String(value || '').replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?/g, '<time>').replace(/\b\d+\b/g, '<n>').replace(/\s+/g, ' ').trim(); }
export function anomalyFingerprint(anomaly) { return crypto.createHash('sha256').update(`${anomaly.label}|${normalizeMessage(anomaly.message)}`).digest('hex').slice(0, 16); }
export function slugify(value) { return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'nightly-health'; }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readLedger(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } }
function redactValue(value) {
  if (typeof value === 'string') return redactAll(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}
function command(exe, args, options = {}) { const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...options }); return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error }; }
function ymd(now) { return now.toISOString().slice(0, 10).replaceAll('-', ''); }

export async function runRemediation({
  home = process.env.ORGIAST_HOME || os.homedir(), now = new Date(), dryRun = false, json = false,
  repo = path.resolve(import.meta.dirname, '..'), playbooks = defaultPlaybooks, run = command,
  notify = notifyKim, decision = addDecision, maxCodex = 3, maxMinutes = 45,
  taskApi = { get: getScheduledTaskInfo, start: startScheduledTask, stop: stopScheduledTask }
} = {}) {
  const input = readJson(path.join(home, '.claude', '.nightly-health-last.json'), { anomalies: [] });
  const anomalies = Array.isArray(input.anomalies) ? input.anomalies : [];
  if (!anomalies.length) {
    const result = { exitCode: 0, fixed: [], prs: [], escalated: [], deferred: [], suppressed: [], skipped: [], plan: [] };
    const cacheTime = input.ranAt || 'キャッシュなし';
    if (json) console.log(JSON.stringify({ ...result, message: `ok:異常なし（${cacheTime}）` }, null, 2));
    else console.log(`ok:異常なし（${cacheTime}）`);
    return result;
  }
  const ledgerFile = path.join(home, '.claude', 'nightly-health-remediate-ledger.jsonl');
  const logFile = path.join(home, '.claude', 'logs', 'nightly-health-remediate.log');
  const prior = readLedger(ledgerFile), started = Date.now();
  const result = { exitCode: 0, fixed: [], prs: [], escalated: [], deferred: [], suppressed: [], skipped: [], plan: [] };
  const tasks = { get: (name) => taskApi.get(name), start: (name) => taskApi.start(name), stop: (name) => taskApi.stop(name) };
  const record = async (anomaly, outcome, extra = {}) => {
    const row = redactValue({ fingerprint: anomalyFingerprint(anomaly), label: anomaly.label, outcome, ...extra, ranAt: now.toISOString() });
    if (!dryRun) {
      const line = `${row.ranAt} ${outcome} ${anomaly.label}${extra.playbook ? ` (${extra.playbook})` : ''}${extra.prUrl ? ` ${extra.prUrl}` : ''}`;
      try { await appendLineWithRetry(ledgerFile, JSON.stringify(row)); }
      catch (error) { console.error(`WARN 台帳追記失敗: ${redactAll(error?.message ?? error)}`); }
      try { await appendLineWithRetry(logFile, line); }
      catch (error) { console.error(`WARN ログ追記失敗: ${redactAll(error?.message ?? error)}`); console.log(line); }
    }
    return row;
  };
  const fileDecision = (text) => { try { decision({ source: 'nightly-health-remediate', text }, { home, now }); } catch (error) { console.error(`WARN decision記録失敗: ${redactAll(error?.message ?? error)}`); } };
  const context = {
    now, tasks, reranToday: false,
    readRepoFile: (file) => fs.readFileSync(path.resolve(repo, file), 'utf8'),
    async waitForLogAdvance(log, minutes) {
      const file = path.join(home, '.claude', 'logs', log); const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      for (let i = 0; i < minutes * 12; i += 1) { await new Promise((resolve) => setTimeout(resolve, 5000)); if (fs.existsSync(file) && fs.statSync(file).mtimeMs > before) return true; }
      return false;
    }
  };
  let codexCount = 0;
  const plan = (anomaly, action, detail = '') => {
    const text = `PLAN ${anomaly.label}: ${action}${detail ? `(${detail})` : ''}`;
    result.plan.push({ label: anomaly.label, action, reason: detail || undefined, text });
    if (!json) console.log(text);
  };
  const defer = async (anomaly, reason) => result.deferred.push(await record(anomaly, dryRun ? 'deferred' : 'deferred', { reason }));
  const seenThisRun = new Set();
  for (const raw of anomalies) {
    const anomaly = { ...raw, logTail: redactAll(raw.logTail || ''), message: redactAll(raw.message || ''), laneReason: redactAll(raw.laneReason || '') };
    const fingerprint = anomalyFingerprint(anomaly);
    if (seenThisRun.has(fingerprint)) { result.skipped.push(await record(anomaly, 'skipped', { reason: '同一実行内で処理済み' })); continue; }
    seenThisRun.add(fingerprint);
    if (prior.some((row) => row.fingerprint === fingerprint && now - new Date(row.ranAt) < DAY)) { result.skipped.push(await record(anomaly, 'skipped', { reason: '同日処理済み' })); continue; }
    let handled = false;
    for (const playbook of playbooks) {
      try {
        if (!await playbook.match(anomaly, context)) continue;
        if (dryRun) { plan(anomaly, `playbook=${playbook.name}`); handled = true; break; }
        const applied = await playbook.apply(anomaly, context);
        const verified = applied.outcome !== 'unhandled' && await playbook.verify(anomaly, context, applied);
        if (!verified) continue;
        const bucket = applied.outcome === 'suppressed' ? result.suppressed : result.fixed;
        bucket.push(await record(anomaly, applied.outcome, { playbook: playbook.name, note: applied.note })); handled = true; break;
      } catch (error) {
        result.playbookErrors ??= [];
        result.playbookErrors.push(await record(anomaly, 'playbook-error', { playbook: playbook.name, reason: redactAll(error?.message ?? error) }));
        handled = true; break;
      }
    }
    if (handled) continue;
    const history = prior.filter((row) => row.fingerprint === fingerprint);
    const recentPr = history.findLast?.((row) => row.outcome === 'pr' && now - new Date(row.ranAt) < 3 * DAY)
      || [...history].reverse().find((row) => row.outcome === 'pr' && now - new Date(row.ranAt) < 3 * DAY);
    const recentEscalation = history.some((row) => row.outcome === 'escalated' && now - new Date(row.ranAt) < 3 * DAY);
    const repeatedlyUnfixed = history.filter((row) => ['deferred', 'pr'].includes(row.outcome) && now - new Date(row.ranAt) < 7 * DAY).length >= 2;
    if (anomaly.laneReason) {
      const reason = anomaly.laneReason;
      if (dryRun) plan(anomaly, 'escalate', reason);
      else {
        fileDecision(`何が起きた: ${anomaly.label} — ${anomaly.message}\nPlaybook判定: ${reason}\n判断してほしい1点: 手動対応を優先するか。`);
        result.escalated.push(await record(anomaly, 'escalated', { reason }));
      }
      continue;
    }
    if (recentPr) {
      const open = run('gh', ['pr', 'list', '--state', 'open', '--search', fingerprint, '--json', 'url'], { cwd: repo });
      let isOpen = true;
      if (open.status === 0) { try { isOpen = JSON.parse(open.stdout || '[]').length > 0; } catch { isOpen = true; } }
      if (isOpen) {
        const reason = open.status === 0 ? '同じfingerprintのPRがopenでマージ待ち' : 'PR状態を確認できないため安全側で持ち越し';
        if (dryRun) plan(anomaly, 'deferred', reason); else await defer(anomaly, reason);
        continue;
      }
    }
    if (recentEscalation) {
      const reason = '前回のescalatedから3日間の冷却中';
      if (dryRun) plan(anomaly, 'deferred', reason); else await defer(anomaly, reason);
      continue;
    }
    if (repeatedlyUnfixed) {
      const reason = '過去7日に2回以上deferred/prを経て再発';
      if (dryRun) plan(anomaly, 'escalate', reason);
      else {
        fileDecision(`何が起きた: ${anomaly.label} — ${anomaly.message}\n何を試した: 過去7日に自動修理または持ち越しを2回以上実施\n判断してほしい1点: 手動対応を優先するか。`);
        result.escalated.push(await record(anomaly, 'escalated', { reason }));
      }
      continue;
    }
    const overCount = codexCount >= maxCodex;
    const overTime = Date.now() - started >= maxMinutes * 60000;
    if (overCount || overTime) {
      const reason = overCount ? '1回3件の修理上限に到達' : '45分の全体上限に到達';
      if (dryRun) plan(anomaly, 'deferred', reason); else await defer(anomaly, reason);
      continue;
    }
    if (dryRun) { codexCount += 1; plan(anomaly, 'codex'); continue; }
    {
      codexCount += 1;
      const slug = `${slugify(anomaly.expectation?.tool || anomaly.label)}-${fingerprint.slice(0, 6)}`;
      const branch = `autofix/${ymd(now)}-${slug}`;
      const worktree = path.join(home, '.claude', 'remediate-worktrees', `${slug}-${ymd(now)}`);
      const promptFile = path.join(os.tmpdir(), `nightly-remediate-${process.pid}-${fingerprint}.txt`);
      const prompt = redactAll(`夜間ジョブ異常を修復してください。\nlabel: ${anomaly.label}\nmessage: ${anomaly.message}\ntool: ${anomaly.expectation?.tool || '要調査'}\nredacted log tail:\n${anomaly.logTail}\n\n真因を特定し最小差分で直す。回帰テストを tools/*.test.mjs に追加。node --test tools/*.test.mjs tools/lib/*.test.mjs が全緑になること。コミットメッセージは fix(${slug}): … 。push はしない。`);
      fs.mkdirSync(path.dirname(worktree), { recursive: true }); fs.writeFileSync(promptFile, prompt, 'utf8');
      let laneReason = '';
      try {
        const added = run('git', ['worktree', 'add', worktree, '-b', branch, 'origin/main'], { cwd: repo });
        if (added.status !== 0) throw new Error(added.stderr || 'worktree add failed');
        const codex = run(process.execPath, [path.join(repo, 'tools', 'codex-do.mjs'), '--prompt-file', promptFile, '--cwd', worktree, '--timeout', '1800'], { cwd: repo, timeout: 31 * 60000 });
        let coded = codex;
        if (codex.status !== 0) coded = run(process.execPath, [path.join(repo, 'tools', 'cheap-code.mjs'), '--provider', 'auto', '--prompt-file', promptFile, '--cwd', worktree], { cwd: repo, timeout: 31 * 60000 });
        if (coded.status !== 0) throw new Error(`修理レーン失敗 codex exit ${codex.status}: ${redactAll(codex.stderr).slice(-200)} / cheap-code exit ${coded.status}: ${redactAll(coded.stderr).slice(-200)}`);
        const tested = run(process.execPath, ['--test', 'tools/*.test.mjs', 'tools/lib/*.test.mjs'], { cwd: worktree, timeout: 20 * 60000 });
        if (tested.status !== 0) throw new Error(`回帰テスト失敗: ${tested.stderr.slice(0, 300)}`);
        const pushed = run('git', ['push', '-u', 'origin', branch], { cwd: worktree, timeout: 120000 }); if (pushed.status !== 0) throw new Error(pushed.stderr);
        const bodyFile = path.join(os.tmpdir(), `nightly-remediate-pr-${process.pid}.txt`);
        fs.writeFileSync(bodyFile, redactAll(`fingerprint: ${fingerprint}\n\n異常: ${anomaly.label}: ${anomaly.message}\n\n変更点: Codexによる最小修復\n検証: 全テスト成功\n`), 'utf8');
        const pr = run('gh', ['pr', 'create', '--label', 'automerge', '--title', `fix(${slug}): ${anomaly.label} を自動修復`, '--body-file', bodyFile], { cwd: worktree });
        if (pr.status !== 0) throw new Error(pr.stderr); const prUrl = pr.stdout.trim();
        result.prs.push(await record(anomaly, 'pr', { prUrl })); handled = true;
      } catch (error) { laneReason = redactAll(error.message || error); }
      finally { run('git', ['worktree', 'remove', '--force', worktree], { cwd: repo }); try { fs.unlinkSync(promptFile); } catch {} }
      if (handled) continue;
      anomaly.laneReason = laneReason;
    }
    const reason = anomaly.laneReason || 'Codexとcheap-codeの修理レーンが失敗';
    fileDecision(`何が起きた: ${anomaly.label} — ${anomaly.message}\n何を試した: Playbookと自動修理レーン（${reason}）\n判断してほしい1点: 自動修理を待たず手動対応を優先するか。`);
    result.escalated.push(await record(anomaly, 'escalated', { reason }));
  }
  if (!dryRun && (result.fixed.length || result.prs.length || result.escalated.length || result.suppressed.length)) {
    const lines = [`🛠 夜間ジョブ異常の自動修復（${now.toISOString().slice(0, 10)}）`, `直った: ${result.fixed.length}件 — ${result.fixed.map((x) => `${x.label}（${x.playbook}）`).join('、') || 'なし'}`, `PR作成: ${result.prs.length}件 — ${result.prs.map((x) => `${x.label} → ${x.prUrl}`).join('、') || 'なし'}`, `次回へ持ち越し: ${result.deferred.length}件`, `人の判断待ち: ${result.escalated.length}件 — ${result.escalated.map((x) => `${x.label}: ${x.reason}`).join('、') || 'なし'}`, `誤検知として除外: ${result.suppressed.length}件`, '台帳: ~/.claude/logs/nightly-health-remediate.log'];
    const text = lines.join('\n'), hash = crypto.createHash('sha256').update(text).digest('hex');
    const stateFile = path.join(home, '.claude', '.nightly-health-remediate-state.json'), state = readJson(stateFile, {});
    if (!(state.hash === hash && now - new Date(state.sentAt) < DAY)) { await notify(text, { home }); fs.writeFileSync(stateFile, JSON.stringify({ hash, sentAt: now.toISOString() })); }
  }
  if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`fixed=${result.fixed.length} pr=${result.prs.length} deferred=${result.deferred.length} escalated=${result.escalated.length} suppressed=${result.suppressed.length}`);
  return result;
}

if (isEntry(import.meta.url)) runRemediation({ dryRun: process.argv.includes('--dry-run'), json: process.argv.includes('--json') }).then((r) => { process.exitCode = r.exitCode; }).catch((e) => { console.error(redactAll(e.stack || e)); process.exitCode = 1; });
