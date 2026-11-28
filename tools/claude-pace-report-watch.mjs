#!/usr/bin/env node
/**
 * 毎朝 7:45 JST の見張り: その日の claude-pace 日次報告が正本に出ていなければ kim-inbox に警告を積む。
 * 2026-11-28 に「ホスト名が 011NEXT で集計担当と判定されず全PCで報告が出ない」事故が
 * 丸一日気付かれなかったため追加した。報告が出ているかどうかだけを見る軽い見張り。
 */
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

export const REPO = 'kimkon1011/orgiast-claude-rules';
export const REPORT_PATH = 'reports/claude-pace';

/** JST の YYYY-MM-DD。 */
export function jstDate(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function contentsUrl(date) {
  return `https://api.github.com/repos/${REPO}/contents/${REPORT_PATH}/${date}.json`;
}

/**
 * 正本に当日の報告 JSON があるか。取得自体に失敗したときは exists=null（「無い」と断定しない）。
 */
export async function checkReport(date, { fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'orgiast-claude-pace-watch/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(contentsUrl(date), { headers });
  } catch (error) {
    return { exists: null, reason: `取得失敗: ${error.name || 'error'}` };
  }
  if (response.status === 404) return { exists: false, reason: 'GitHub API が 404' };
  if (!response.ok) return { exists: null, reason: `HTTP ${response.status}` };
  let body;
  try { body = await response.json(); } catch { return { exists: null, reason: 'JSON として読めない' }; }
  const size = Number(body?.size);
  if (!Number.isFinite(size) || size <= 0) return { exists: false, reason: 'size が 0' };
  return { exists: true, size };
}

export function buildWarning(date, result, host) {
  const detail = result.exists === null
    ? `正本の確認に失敗しました（${result.reason}）。報告が出たかどうか分かっていません。`
    : `正本に ${REPORT_PATH}/${date}.json がありません（${result.reason}）。`;
  return [
    `claude-pace 日次報告が出ていません（${date} 7:45 JST 時点・${host} の見張り）`,
    detail,
    '',
    '確かめる所:',
    `- https://github.com/${REPO}/blob/main/${REPORT_PATH}/${date}.json`,
    '- 011 と 018 の OrgiastClaudePaceReport（毎朝 7:30）の最終実行結果',
    '',
    '出し直す時は 018 で: node tools/claude-pace-report.mjs --force',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const nowMs = io.now ?? Date.now();
  const host = io.host ?? process.env.ORGIAST_HOSTNAME ?? os.hostname();
  const dateAt = argv.indexOf('--date');
  const date = dateAt >= 0 ? argv[dateAt + 1] : jstDate(nowMs);
  const dryRun = argv.includes('--dry-run');
  const print = io.print ?? console.log;

  const result = await checkReport(date, { fetchImpl: io.fetchImpl, token: io.token });
  if (result.exists === true) {
    print(`claude-pace-report-watch ok date=${date} size=${result.size}`);
    return { ok: true, date, size: result.size, warned: false };
  }

  const message = buildWarning(date, result, host);
  if (dryRun) {
    print(message);
    return { ok: false, date, reason: result.reason, warned: false, dryRun: true };
  }
  // kim-inbox へ積む。io.addItem が渡されていればそれを使う（テスト用）。
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const addItem = io.addItem ?? (await import('./kim-inbox.mjs')).addItem;
  let warned = false;
  let warnError = null;
  try {
    await addItem(home, { kind: 'ask', text: message, source: 'claude-pace-report-watch' });
    warned = true;
  } catch (error) {
    warnError = String(error?.message || error);
  }
  print(`claude-pace-report-watch missing date=${date} reason=${result.reason} warned=${warned}${warnError ? ` error=${warnError}` : ''}`);
  return { ok: false, date, reason: result.reason, warned, warnError };
}

if (isEntry(import.meta.url)) await main();