#!/usr/bin/env node
// 夜間バッチ3件の健全性を毎朝チェックし、既知原因(Disabled)だけ自動修復して Discord へ報告する。
//
// これは実機のスケジュールタスク OrgiastNightWatchdog が毎朝 09:00 に呼ぶスクリプトで、
// その Description が仕様の正本:
//   「夜間バッチ3件(AutoSession/FleetPoller/NightlyBatch)の健全性を毎朝チェックし、
//     既知原因のみ自動修復してDiscordへ報告する」
//
// 既存の nightly-health.mjs / nightly-health-remediate.mjs とは役割が別。
// あちらは「ログの鮮度」と「既存プレイブック」を見るのに対し、`state === 'Disabled'`
// （誰かがタスクを無効化した＝起動要求すら発生しない状態）は repo 全体でどこも扱っていない。
// ここはその空白だけを埋める。既存2ファイルには手を入れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getScheduledTaskInfo, enableScheduledTask } from './lib/scheduled-task.mjs';
import { findWebhook, notify } from './auto-session.mjs';
import { isEntry } from './is-entry.mjs';

const HOUR = 60 * 60 * 1000;

// 監視対象。実機タスクの Description が名指しする3件で固定（引数で増減させない）。
export const WATCHED_TASKS = ['OrgiastAutoSession', 'OrgiastFleetPoller', 'OrgiastNightlyBatch'];

// Running のまま何時間を超えたら異常とするか。既存 nightly-health の maxRunHours(5h) に合わせる。
const MAX_RUN_HOURS = 5;

// Get-ScheduledTaskInfo の LastTaskResult は「失敗」以外の状態値も返す。
// 267009=実行中 / 267011=未実行。どちらも異常ではないので失敗扱いにしない。
const RESULT_RUNNING = 267009;
const RESULT_NOT_YET_RUN = 267011;

function shortError(error) {
  return String(error?.message ?? error ?? '不明');
}

// タスク1件を判定して異常の配列を返す純関数（実機に触らない）。
// 返り値の各要素: { taskName, kind, message, autoFixable }
export function classifyTaskHealth(taskName, info, { now = new Date(), maxRunHours = MAX_RUN_HOURS } = {}) {
  const item = (kind, message, autoFixable = false) => ({ taskName, kind, message, autoFixable });

  if (!info) return [item('missing', 'スケジュールタスクが登録されていません')];

  // Disabled を neverRun より先に見る。無効化されたタスクは起動要求自体が発生せず
  // LastRunTime が 1999 年のままになるため、neverRun を先に除外すると
  // 「1度も動いていない＝正常」と誤って黙ってしまう（この道具の主目的がそこなので順序が重要）。
  if (info.state === 'Disabled') {
    return [item('disabled', 'タスクが無効化されています（起動要求が発生しない状態）', true)];
  }

  // 一度も実行されていないタスクは lastRunTime が 1999 年になる。新規PCの初回で
  // 「起動したのにログが無い」と誤検知しないため無条件で除外する（既存 nightly-health と同じ扱い）。
  if (info.neverRun) return [];

  const lastRunMs = Date.parse(info.lastRunTime);
  const anomalies = [];

  if (info.state === 'Running' && Number.isFinite(lastRunMs) && (now.getTime() - lastRunMs) / HOUR > maxRunHours) {
    anomalies.push(item('running-too-long', `実行が上限 ${maxRunHours} 時間を超えて継続中（開始: ${info.lastRunTime}）`));
  }

  const result = Number(info.lastTaskResult);
  if (Number.isFinite(result) && result !== 0 && result !== RESULT_RUNNING && result !== RESULT_NOT_YET_RUN) {
    anomalies.push(item('last-run-failed', `直近の実行結果が 0 以外（lastTaskResult=${result}）`));
  }

  return anomalies;
}

export function buildWatchdogMessage({ found, fixed, problems, dryRun = false, now = new Date() } = {}) {
  const date = now.toISOString().slice(0, 10);
  const lines = [`🌙 夜間ウォッチドッグ（${date}）`];
  lines.push(`監視: ${WATCHED_TASKS.join(' / ')}`);
  if (dryRun) lines.push('⚠️ dry-run のため修復も送信もしていません');
  if (fixed.length) lines.push(`自動修復: ${fixed.length}件 — ${fixed.map((x) => `${x.taskName}（${x.kind}）`).join('、')}`);
  if (!fixed.length) lines.push('自動修復: なし');
  lines.push(`要確認: ${problems.length}件${problems.length ? ` — ${problems.map((x) => `${x.taskName}: ${x.message}`).join('、')}` : ''}`);
  lines.push('ログ: ~/.claude/logs/night-watchdog.log');
  return lines.join('\n');
}

function appendLogLine(logFile) {
  return (line) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  };
}

// io で queryTask / enableTask / notifyFn / now / logFile / home を差し替えられる（テスト用）。
export async function main(argv = process.argv.slice(2), io = {}) {
  const dryRun = argv.includes('--dry-run');
  const asJson = argv.includes('--json');

  const home = io.home || os.homedir();
  const logFile = io.logFile || path.join(home, '.claude', 'logs', 'night-watchdog.log');
  const now = io.now || new Date();
  const queryTask = io.queryTask || ((name) => getScheduledTaskInfo(name));
  const enableTask = io.enableTask || ((name) => enableScheduledTask(name));
  const notifyFn = io.notifyFn || notify;
  // 終了コードも差し替え可能にする。テスト中に process.exitCode を触ると
  // テストランナー自身の終了コードが汚れ、緑なのに赤く見える。
  const setExitCode = io.setExitCode || ((code) => { process.exitCode = code; });
  const log = io.appendLog || appendLogLine(logFile);
  const stamp = now.toISOString();

  const found = [];
  for (const taskName of WATCHED_TASKS) {
    let info = null;
    try {
      info = await queryTask(taskName);
    } catch (error) {
      // 取得失敗を「異常なし」に倒さない。黙って見逃すくらいなら鳴らす。
      found.push({ taskName, kind: 'query-failed', message: `状態を取得できませんでした（${shortError(error)}）`, autoFixable: false });
      continue;
    }
    found.push(...classifyTaskHealth(taskName, info, { now }));
  }

  const fixed = [];
  const problems = [];

  for (const entry of found) {
    if (!entry.autoFixable) { problems.push(entry); continue; }
    if (dryRun) { problems.push(entry); continue; }
    try {
      await enableTask(entry.taskName);
      // 「有効化コマンドが通った」ではなく「本当に Disabled でなくなった」で判定する。
      // 再取得して確認できないものは直ったことにしない。
      const after = await queryTask(entry.taskName);
      entry.fixedAt = stamp;
      if (after && after.state !== 'Disabled') fixed.push(entry);
      else problems.push({ ...entry, message: `${entry.message}（再有効化を実行したが Disabled のまま）` });
    } catch (error) {
      problems.push({ ...entry, message: `${entry.message}（再有効化に失敗: ${shortError(error)}）` });
    }
  }

  for (const entry of found) log(`${stamp} ${entry.kind} ${entry.taskName} ${entry.message}`);
  for (const entry of fixed) log(`${stamp} fixed ${entry.taskName} (${entry.kind} → 有効化)`);
  log(`${stamp} ok=${problems.length === 0} found=${found.length} fixed=${fixed.length} remaining=${problems.length}${dryRun ? ' dry-run' : ''}`);

  const result = { ok: problems.length === 0, found, fixed, problems, notified: false, dryRun };

  if (!found.length) {
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log('夜間ウォッチドッグ: 異常なし');
    return result;
  }

  const text = buildWatchdogMessage({ found, fixed, problems, dryRun, now });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(text);

  // 異常が無い日は送らない（毎朝の無駄な通知を出さない）。ログには必ず残す。
  if (!dryRun) {
    const webhook = io.webhook ?? findWebhook(path.join(home, '.claude'));
    try {
      await notifyFn(webhook, text);
      result.notified = Boolean(webhook);
    } catch (error) {
      // Discord が落ちていても判定結果は変えない。監視自体を止めないため。
      console.error(`night-watchdog: Discord通知に失敗しました: ${shortError(error)}`);
    }
  }

  // 自動修復まで含めて解決した日は成功として終える（直したのに失敗扱いにすると
  // lastTaskResult が汚れ、別の監視が鳴る）。未解決が残った日だけ 1。
  if (problems.length) setExitCode(1);
  return result;
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`night-watchdog: ${error.message}`);
    process.exitCode = 1;
  });
}
