import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rowKey, originLine } from './auto-progress-ledger.mjs';
import { notifyOwner, resolveOwner } from './notify-owner.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

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
  return { code, text: oneLine(result.stdout) || (code === 0 ? '達成を確認' : code === 1 ? '未達' : `check エラー: ${failure}`), stderr: gotStderr };
}
export function queueCheckFollowup(home, row, result) {
  const file = path.join(home, '.claude', 'next-session.md');
  const marker = `<!-- auto-progress-check:${createHash('sha256').update(rowKey(row) + row.check + row.deadlineAt).digest('hex').slice(0, 20)} -->`;
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text.includes(marker)) return;
  const item = `- [ ] [auto-progress] ${oneLine(row.label || row.promise)}: ${oneLine(result.text)}。Claude の次の手: ${oneLine(row.nextClaude || 'check の実行ログと対象の受け口を調査し、原因を修正して再確認する')} ${marker}\n`;
  text = /^## 残TODO\s*$/m.test(text) ? text.replace(/(^## 残TODO\s*$)/m, `$1\n${item}`) : `${text}\n## 残TODO\n${item}`;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
export async function checkPromise(row, { home, now, patch, io = {} }) {
  const result = row.status === 'done' && row.checkResult === 'done'
    ? { code: 0, text: row.checkText } : await (io.executeCheck ?? executeCheck)(row, { home });
  const state = result.code === 0 ? 'done' : result.code === 1 ? 'unmet' : 'error';
  const overdue = now >= Date.parse(row.deadlineAt);
  const changes = { checkResult: state, checkText: oneLine(result.text), lastCheckedAt: new Date(now).toISOString(),
    lastCheckExit: result.code, lastCheckStderr: oneLine(result.stderr || '', 200),
    verdict: state === 'done' ? 'done' : state === 'error' ? 'check_error' : overdue ? 'unmet' : 'in_progress',
    ...(state === 'done' ? { status: 'done', doneAt: row.doneAt || new Date(now).toISOString() } : {}) };
  if (patch(rowKey(row), changes) === false) return 'ledger_error';
  if (state === 'unmet' && !overdue) {
    const lastNotified = Date.parse(row.lastUnmetNotifiedAt || row.ts) || 0;
    if (now - lastNotified < UNMET_INTERVAL_MS) return state;
    const next = oneLine(row.nextClaude || 'check の実行ログと対象の受け口を調査し、原因を修正して再確認する');
    const extra = `[exit: ${result.code}]${result.stderr ? ` stderr: ${oneLine(result.stderr, 200)}` : ''}`;
    const message = `未達: ${changes.checkText} ${extra}/ 次の手: ${next}`;
    const owner = row.owner || resolveOwner({ home });
    const origin = originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: owner, home });
    const delivery = await (io.notifyOwner ?? notifyOwner)(owner, `${origin}\n${message}`, { home });
    if (!['dm', 'toast', 'inbox'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
    const notifyChanges = { lastUnmetNotifiedAt: new Date(now).toISOString() };
    if (patch(rowKey(row), notifyChanges) === false) return 'ledger_error';
    Object.assign(row, notifyChanges);
    return state;
  }
  if (state !== 'done') (io.queueCheckFollowup ?? queueCheckFollowup)(home, row, result);
  // State, not volatile stdout/count/timestamps, determines duplicate delivery.
  if (row.checkNotifiedResult === state) return state;
  const next = oneLine(row.nextClaude || 'check の実行ログと対象の受け口を調査し、原因を修正して再確認する');
  const extra = state !== 'done' && result?.code !== undefined
    ? `\n[exit: ${result.code}]${result.stderr ? `\nstderr: ${oneLine(result.stderr, 200)}` : ''}`
    : '';
  const message = `${state === 'done' ? '完了' : state === 'unmet' ? '未達（期限超過）' : '確認エラー'}: ${oneLine(row.label || row.promise, 80)}\n${changes.checkText}${extra}${state === 'done' ? '' : `\nClaude の次の手: ${next}（next-session.md に起票）`}`;
  const owner = row.owner || resolveOwner({ home });
  const origin = originLine(row, { label: io.label ?? resolveFleetLabel(home), localOwner: owner, home });
  const delivery = await (io.notifyOwner ?? notifyOwner)(owner, `${origin}\n${message}`, { home });
  if (!['dm', 'toast', 'inbox'].includes(delivery?.delivered)) throw new Error(delivery?.reason || 'DM not delivered');
  patch(rowKey(row), { checkNotifiedResult: state });
  return state;
}
