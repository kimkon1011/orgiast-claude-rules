#!/usr/bin/env node
// /session-close で閉じた次のセッションに「session-start を最初に実行せよ」を自動注入する。
// 予約(arm)は閉じる側が明示的に置く。単に窓を閉じただけでは発火させない（暴走して毎回セッションが自走するのを防ぐ）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const ARM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// compact / resume は「同じ作業の続き」なので除外する。ここに入れると、
// 過去セッションを --resume で開き直しただけで引き継ぎ票の別目的に引きずられる。
export const INJECT_SOURCES = new Set(['startup', 'clear', 'fork']);

export function statePathFor(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'session-relaunch.json');
}

export function normalizeState(value) {
  const armed = value?.armed;
  const valid = armed && typeof armed.at === 'string' && Number.isFinite(Date.parse(armed.at));
  return {
    enabled: value?.enabled !== false,
    armed: valid ? { at: armed.at, sessionId: String(armed.sessionId || ''), cwd: String(armed.cwd || '') } : null,
  };
}

export function armState(state, { sessionId, cwd, now }) {
  if (!state.enabled) return state;
  return {
    ...state,
    armed: { at: new Date(now).toISOString(), sessionId: String(sessionId || ''), cwd: String(cwd || '') },
  };
}

export function shouldInject(state, input, now) {
  if (!state?.enabled || !state.armed) return false;
  const elapsed = now - Date.parse(state.armed.at);
  if (!(elapsed >= 0 && elapsed <= ARM_TTL_MS)) return false;
  const sessionId = String(input?.session_id || '');
  // セッションIDが取れないと「閉じた本人」を弾けず、同じセッションに注入し返す恐れがある。
  if (!sessionId || sessionId === state.armed.sessionId) return false;
  return INJECT_SOURCES.has(input?.source);
}

export function buildContext(armed) {
  const date = new Date(armed.at);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return [
    '【自動再開: 前セッションは /session-close 済み】',
    `前セッションは ${stamp} に閉じられた。作業ディレクトリ: ${armed.cwd || '(不明)'}`,
    'このセッションの最初の行動として、Skill ツールで session-start スキルを実行し、~/.claude/next-session.md の引き継ぎ票から目的を1件だけ確定してから着手せよ。',
    'ユーザーが既に別の依頼を書いている場合は、その依頼を優先し、この自動再開は無視してよい。',
    'この自動再開を止めたいときは `node ~/orgiast-claude-rules/tools/session-relaunch.mjs --off`。',
  ].join('\n');
}

// 他ツール(next-session-launch の inline モード)から予約を置けるようにする。
export function armToFile({ home, sessionId, cwd, now = Date.now() } = {}) {
  const file = statePathFor(home);
  const state = readState(file);
  if (!state.enabled) return false;
  writeState(file, armState(state, { sessionId, cwd, now }));
  return true;
}

function readState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { enabled: true, armed: null };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// フックが本体をブロックしないよう、stdin が閉じない環境でも必ず有限時間で抜ける。
function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(raw); } };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

function flagValue(args, name, fallback) {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

async function main(argv) {
  const file = statePathFor();
  const state = readState(file);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('使い方: node tools/session-relaunch.mjs [--hook] | --arm [--session <id>] [--cwd <path>] | --disarm | --on | --off | --status');
    return;
  }

  if (argv.includes('--arm')) {
    if (!state.enabled) {
      console.log('自動再開は無効です（有効化: --on）');
      return;
    }
    writeState(file, armState(state, {
      sessionId: flagValue(argv, '--session', ''),
      cwd: flagValue(argv, '--cwd', process.cwd()),
      now: Date.now(),
    }));
    console.log('次のセッションで /session-start を自動実行します（解除: --disarm）');
    return;
  }

  if (argv.includes('--disarm')) {
    writeState(file, { ...state, armed: null });
    console.log('自動再開の予約を解除しました');
    return;
  }

  if (argv.includes('--on')) {
    writeState(file, { ...state, enabled: true });
    console.log('自動再開を有効にしました');
    return;
  }

  if (argv.includes('--off')) {
    writeState(file, { enabled: false, armed: null });
    console.log('自動再開を無効にしました（再開: --on）');
    return;
  }

  if (argv.includes('--status')) {
    const armed = state.armed ? `予約あり: ${state.armed.at} (${state.armed.cwd || '不明'})` : '予約なし';
    console.log(`${state.enabled ? '有効' : '無効'} / ${armed}`);
    return;
  }

  const raw = (await readStdin()).trim();
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const fresh = readState(file);
  if (!shouldInject(fresh, input, Date.now())) return;
  // 二重注入を防ぐため、出力より先に予約を落とす。
  writeState(file, { ...fresh, armed: null });
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildContext(fresh.armed) },
  }));
}

if (isEntry(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const humanCommand = process.argv.slice(2).some((arg) => arg !== '--hook');
    if (humanCommand) console.error(`session-relaunch: ${error.message}`);
  }
  process.exit(0);
}
