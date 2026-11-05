import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isUnattendedRow, rowKey, originLine } from './auto-progress-ledger.mjs';
import { notifyOwner, resolveOwner } from './notify-owner.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { deliverDoneInbox, hasDoneInboxReceipt } from './lib/auto-progress-done-inbox.mjs';

export const CHECK_ERROR_PATTERNS = [
  /Cannot find path/i,
  /パスが存在しない/,
  /is not recognized/i,
  /command not found/i,
  /No such file/i,
  /ParserError/,
  /SyntaxError/,
  /CommandNotFoundException/,
  /ItemNotFoundException/,
];

export const CHECK_TIMEOUT_MS = 30000;
export const MAX_CHECK_TIMEOUT_MS = 300000;
export const UNMET_INTERVAL_MS = 6 * 3600000;
// 外部の成果を読まず、時計と定数だけで決まる典型的な判定。
// 登録時だけでなく、旧台帳を評価する watch からも同じ判定を使う。
export function isTimeOnlyCheck(command) {
  const text = String(command || '');
  if (!/Date\.(?:now|parse)|new\s+Date|Get-Date|date\s+['"]?\+%s/i.test(text)) return false;
  if (/\b(?:fs|require|import|child_process|fetch|argv|env|stdin|readFile|Test-Path|Get-Content)\b/i.test(text)) return false;
  const code = text.replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, match => {
    return /Date|date\s+.*%s/i.test(match) ? match.slice(1, -1) : '';
  }).replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, '');
  const words = code.match(/[A-Za-z_$][\w$]*/g) || [];
  const allowed = new Set(['node', 'exe', 'e', 'eval', 'process', 'exit', 'exitCode', 'Date', 'now', 'parse', 'new', 'getTime', 'valueOf', 'if', 'else', 'true', 'false', 'powershell', 'pwsh', 'NoProfile', 'Command', 'Get', 'date', 's', 'DateTime', 'datetime', 'int', 'long', 'gt', 'ge', 'lt', 'le', 'eq', 'ne', 'and', 'or', 'not', 'test']);
  return words.every(word => word === '$' || allowed.has(word));
}
export function hasCheckError(stderr) {
  return CHECK_ERROR_PATTERNS.some(pattern => pattern.test(stderr));
}

/** 二重引用符内の $env: を bash が展開する問題の静的検査 */
export function hasBashEnvExpansion(command) {
  return /(?<!\\)\$env:/i.test(command);
}

/**
 * addCheck の事前確認:
 * 1. 静的検査（$env: 展開の検出）
 * 2. 試し実行
 * 戻り値: { ok, code, text, stderr, preflight }
 *   ok=false → 登録拒否（exit 2）
 *   preflight=already_met → exit 0 で達成済み
 *   preflight=unmet → exit 1 で未達（正常）
 *   preflight=static_error → $env: 展開を検出
 *   preflight=stderr_error → stderr にエラー印を検出
 */
export function preflightCheck(row, { home, forceCheck = false } = {}) {
  // 静的検査
  if (!forceCheck && hasBashEnvExpansion(row.check)) {
    const msg = [
      `静的検査に失敗しました。check 文字列に '$env:' が含まれています。`,
      `bash が '$env' を展開し、空文字に置換されます。`,
      `PowerShell の '$env:' 変数を使う場合は、単一引用符で囲むか '\\$env:' とエスケープしてください。`,
      `例: powershell -NoProfile -Command 'if ((Get-Item $env:USERPROFILE\\\\.claude\\\\...))'`,
      `例: powershell -NoProfile -Command "if ((Get-Item \\$env:USERPROFILE\\\\.claude\\\\...))"`,
    ].join('\n');
    return { ok: false, code: 2, text: msg, stderr: msg, preflight: 'static_error' };
  }
  // 試し実行
  const result = executeCheck(row, { home });
  if (result.code === 0) {
    return { ok: true, code: 0, text: result.text, stderr: result.stderr, preflight: 'already_met' };
  }
  if (result.code === null) {
    const msg = `check が実行できませんでした: ${result.text}`;
    if (!forceCheck) return { ok: false, code: null, text: msg, stderr: result.stderr, preflight: 'exec_error' };
    return { ok: true, code: null, text: msg, stderr: result.stderr, preflight: 'overridden' };
  }
  // 非ゼロ終了
  if (!forceCheck && hasCheckError(result.stderr || '')) {
    const tail = (result.stderr || '').slice(-500);
    const msg = [
      `check がエラーで終了しました(exit ${result.code})。stderr の末尾(500字):`,
      tail,
      '',
      '修正方法:',
      '・コマンドの構文を確認してください。',
      "・PowerShell の $env: 変数は bash に展開されます。単一引用符で囲むか \\$env: とエスケープしてください。",
      '・上記で解決しない場合は --force-check で強制登録できます。',
    ].join('\n');
    return { ok: false, code: 2, text: msg, stderr: result.stderr, preflight: 'stderr_error' };
  }
  return { ok: true, code: result.code, text: result.text, stderr: result.stderr, preflight: result.code === 1 ? 'unmet' : 'unexpected' };
}
// GitHub ログ取得のようにネットワーク待ちが支配的な check は行ごとに延ばせる。
// 行の値が不正・過大なときは既定（30秒）と上限（300秒）へ丸める。check 自体を無制限にはしない。
export function resolveCheckTimeout(row) {
  const value = Number(row?.checkTimeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_CHECK_TIMEOUT_MS) : CHECK_TIMEOUT_MS;
}
export const oneLine = (value, limit = 240) => String(value || '').split(/\r?\n/, 1)[0].trim().slice(0, limit);
export function resolveCheckShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return null;
  if (env.ORGIAST_CHECK_SHELL) return env.ORGIAST_CHECK_SHELL;
  const candidates = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find(candidate => candidate && exists(candidate)) || null;
}
export function executeCheck(row, { home, spawnImpl = spawnSync, shellPath = resolveCheckShell() } = {}) {
  const options = { cwd: row.checkCwd || row.cwd, encoding: 'utf8',
    timeout: resolveCheckTimeout(row), maxBuffer: 64 * 1024, windowsHide: true,
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_CHECK_TIMEOUT_MS: String(resolveCheckTimeout(row)) } };
  const result = shellPath ? spawnImpl(shellPath, ['-c', row.check], options)
    : spawnImpl(row.check, { ...options, shell: true });
  const code = result.error || result.signal ? null : result.status;
  const gotStderr = String(result.stderr || '');
  // spawnSync の生メッセージ（… bash.exe ETIMEDOUT）はシェル故障に見えるため、上限超過と延長方法を書く。
  const failure = result.error?.code === 'ETIMEDOUT'
    ? `check が ${options.timeout / 1000} 秒の上限を超えました（遅い check は --add-check --timeout <秒> で延長・最大 ${MAX_CHECK_TIMEOUT_MS / 1000} 秒）`
    : oneLine(result.error?.message || gotStderr) || code;
  return { code, text: String(result.stdout || '').trim() || (code === 0 ? '達成を確認' : code === 1 ? '未達' : `check エラー: ${failure}`), stderr: gotStderr };
}
// Count each nonempty evidence line once; negative markers take precedence over 完了/達成.
export function checkProgressSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const unmet = lines.filter(s => /未達|未完|なし|失敗|エラー|停止|不足|未配布|NG|✗|❌|pending|unmet|failed/i.test(s));
  const done = lines.filter(s => !unmet.includes(s) && /達成|完了|済|成功|あり|OK|✅|done|passed/i.test(s));
  const unknown = lines.filter(s => !unmet.includes(s) && !done.includes(s));
  return `達成 ${done.length}件 / 未達 ${unmet.length}件${unknown.length ? ` / 判定不明 ${unknown.length}件` : ''}\n達成: ${done.join(' ／ ').slice(0, 450) || '確認なし'}\n未達: ${unmet.join(' ／ ').slice(0, 650) || '確認なし'}${unknown.length ? `\nその他: ${unknown.join(' ／ ').slice(0, 250)}` : ''}`;
}
export function pendingAction(row) {
  const human = !String(row.nextClaude || '').trim() && /待ち|受け取ったら|返信|貼|承認/.test([row.label, row.promise, row.nextKim].join(' '));
  if (human) return `あなたの作業待ち: ${row.label || row.promise}\n${row.ask || row.promise || ''}`;
  return `Claude の次の手: ${oneLine(row.nextClaude || 'check の実行ログと対象の受け口を調査し、原因を修正して再確認する')}${row.ask ? `\n${row.ask}` : ''}`;
}
export function queueCheckFollowup(home, row, result) {
  const file = path.join(home, '.claude', 'next-session.md');
  const marker = `<!-- auto-progress-check:${createHash('sha256').update(rowKey(row) + row.check + row.deadlineAt).digest('hex').slice(0, 20)} -->`;
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text.includes(marker)) return;
  const item = `- [ ] [auto-progress] ${oneLine(row.label || row.promise)}: ${oneLine(result.text)}。${pendingAction(row)} ${marker}\n`;
  text = /^## 残TODO\s*$/m.test(text) ? text.replace(/(^## 残TODO\s*$)/m, `$1\n${item}`) : `${text}\n## 残TODO\n${item}`;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
export async function checkPromise(row, { home, now, patch, io = {}, suppressNotices = false }) {
  if (isTimeOnlyCheck(row.check)) return 'time_only';
  let result;
  try {
    result = row.status === 'done' && row.checkResult === 'done'
      ? { code: 0, text: row.checkText } : await (io.executeCheck ?? executeCheck)(row, { home });
  } catch (error) { result = { code: null, text: `check エラー: ${error.message || error}` }; }
  const state = result.code === 0 ? 'done' : result.code === 1 ? 'unmet' : 'error';
  const overdue = now >= Date.parse(row.deadlineAt);
  const changes = { checkResult: state, checkText: String(result.text || ''), checkStderr: String(result.stderr || ''), lastCheckedAt: new Date(now).toISOString(),
    verdict: state === 'done' ? 'done' : state === 'error' ? 'check_error' : overdue ? 'unmet' : 'in_progress',
    ...(state === 'done' ? { status: 'done', doneAt: row.doneAt || new Date(now).toISOString() } : {}) };
  if (patch(rowKey(row), changes) === false) return 'ledger_error';
  if (state === 'done') {
    if (hasDoneInboxReceipt(row)) return state;
    const next = String(row.nextClaude || '').trim();
    const checkSummary = oneLine(row.check, 240);
    const message = `✅ check 達成: ${oneLine(row.label || row.promise, 160)}\n${changes.checkText}\n確認コマンド: ${checkSummary}\n作業ID: ${row.sessionId || rowKey(row)}\n${next ? `作業全体の完了は未確認です。Claude の次の手（実行状況を確認して続行）: ${next.slice(0, 1800)}` : 'kim がすること: なし'}`;
    const delivery = await deliverDoneInbox(home, [row], message, { now, io });
    const receipt = { ...delivery.receipt, checkNotifiedResult: 'done' };
    if (patch(rowKey(row), receipt) === false) return 'ledger_error';
    Object.assign(row, changes, receipt);
    return state;
  }
  Object.assign(row, changes);
  if (suppressNotices) return state;
  if (state === 'unmet') {
    const lastNotified = Date.parse(row.lastUnmetNotifiedAt || (!overdue ? row.ts : '')) || 0;
    if ((!overdue || row.checkNotifiedResult === 'unmet') && now - lastNotified < (overdue ? 24 * 3600000 : UNMET_INTERVAL_MS)) return state;
    if (overdue) (io.queueCheckFollowup ?? queueCheckFollowup)(home, row, result);
    const message = `${overdue ? `期限切れ（${row.deadlineAt}）: ${row.label || row.promise}` : `未達: ${row.label || row.promise}`}\n${checkProgressSummary(changes.checkText)}\n${pendingAction(row)}`;
    const owner = row.owner || resolveOwner({ home });
    const origin = originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: owner, home });
    const delivery = await (io.notifyOwner ?? notifyOwner)(owner, `${origin}\n${message}`, { home, now, kind: state === 'done' && !isUnattendedRow(row, home) ? 'done-requested' : pendingAction(row).startsWith('あなたの作業待ち:') ? 'action' : 'automatic', session: row });
    if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
    const notifyChanges = { lastUnmetNotifiedAt: new Date(now).toISOString(), ...(overdue ? { checkNotifiedResult: 'unmet' } : {}) };
    if (patch(rowKey(row), notifyChanges) === false) return 'ledger_error';
    Object.assign(row, notifyChanges);
    return state;
  }
  if (state !== 'done') (io.queueCheckFollowup ?? queueCheckFollowup)(home, row, result);
  // State, not volatile stdout/count/timestamps, determines duplicate delivery.
  if (row.checkNotifiedResult === state) return state;
  const message = `${state === 'done' ? '完了' : '確認エラー'}: ${oneLine(row.label || row.promise, 80)}\n${changes.checkText}${state === 'done' ? '' : `\n${pendingAction(row)}（next-session.md に起票）`}`;
  const owner = row.owner || resolveOwner({ home });
  const origin = originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: owner, home });
  const delivery = await (io.notifyOwner ?? notifyOwner)(owner, `${origin}\n${message}`, { home, now, kind: state === 'done' && !isUnattendedRow(row, home) ? 'done-requested' : pendingAction(row).startsWith('あなたの作業待ち:') ? 'action' : 'automatic', session: row });
  if (!['dm', 'session-inbox', 'toast', 'inbox', 'deferred'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
  patch(rowKey(row), { checkNotifiedResult: state });
  return state;
}
