#!/usr/bin/env node
/**
 * handoff-audit-commit-deferral-scan.mjs — 「実装タスクの完了報告で、コミットだけを
 * 指示範囲外として未実施のまま終えた」turn を一次記録から数える読み取り専用ツール。
 *
 * なぜ要るか: handoff-audit の TODO `[handoff-audit:585214efa82b1c11] 実装タスクの完了報告
 * （コミットだけ指示範囲外で保留）` は「この handoff が再発していないか」を実物で検証させる。
 * 再発の有無は、台帳(handoff-audit-ledger.jsonl)と transcript(projects/**) を走査すれば
 * 資格情報なし・追加権限なしで数えられる。
 *
 * 出典（この型が立ち上がった実物）: session 98282861（2026-10-12T23:51Z・assign-app の
 * MAA-04/MAA-06 実装）。完了報告の末尾が
 *   「残 TODO … ⏳ 次回: `git commit`（指示により未実施）」
 *   「この後の自動進行: なし（目的完了・コミットは指示範囲外のため保留）」
 * で終わり、実装4ファイルが未コミットのまま handoff された。同じ窓に同型が複数ある
 * （332c836c / 0ef50487 / 011892ed / 13c7b7ed / 8769a59d / 17dc61be）。
 *
 * 再発の定義: 1 turn の中で『commit/コミットの語』と『未実施・未コミット・指示範囲外・
 *             そちらで実施・していません 等の"やっていない"標識』が近接（±40 文字）して
 *             共起すること。監査 TODO 文そのもの・knowledge の pattern 文は除外する
 *             （毎セッションのプロンプトに入るため、数えると自己言及で膨らむ）。
 *
 * 使い方:
 *   node tools/handoff-audit-commit-deferral-scan.mjs                    # 既定窓(28日前〜現在)
 *   node tools/handoff-audit-commit-deferral-scan.mjs --since 2026-10-13
 *   node tools/handoff-audit-commit-deferral-scan.mjs --selftest         # 陽性5・陰性5の対照
 *
 * 検出力: 走査結果だけでは「0 件」が「検出できなかった」なのか「本当に無かった」なのか
 *         区別できない。報告する前に --selftest を通し、対照が全通過してから件数を書くこと。
 *
 * 限界: 判定は 1 turn 内の近接共起を要求する。turn をまたいだ言及は取りこぼす。また
 *       「コミットは不要（README の commit は不要）」のように commit 語が別文脈で出る場合は
 *       偽陽性になりうる（運用では人手で分類する）。0 件は「その型が無かった」であって
 *       「コミット未実施が皆無だった」ではない。
 *
 * 終了コード: 0 = 走査を完走（0 件でも 0。0 は「測った 0」） / 1 = --selftest が落ちた
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const COMMIT = '(?:git\\s+)?commit|コミット';
// 「やっていない」標識。commit 語の近傍（±40 文字）にあるときだけ再発とみなす。
const NOTDONE = [
  '指示範囲外', '指示により未実施', '指示どおり', '未コミット', '未実施', '保留',
  'commit\\s*禁止', 'コミット\\s*禁止', '禁止',
  'していません', 'していない', 'しませんでした', 'ませんでした',
  'そちらで実施', '監督側で実施', 'そちら側',
  'しない', 'せず', 'なし', '不要',
].join('|');

const AROUND = 40;
// 「未コミット」のように COMMIT 語と NOTDONE 語が重なって同居する語は、近接共起では拾えないため
// 直接指定する（未コミット＝コミット語が「未〜」の中に埋もれる）。同様に「コミット未実施」等。
const DIRECT = [
  '未コミット',
  '(?:コミット|commit)\\s*未実施',
  '(?:コミット|commit)[^\\n]{0,8}?(?:しない|しません|していない|していません|禁止|なし|不要)',
].join('|');
const det = new RegExp(
  `(?:${DIRECT})|(?:${COMMIT})[\\s\\S]{0,${AROUND}}?(?:${NOTDONE})|(?:${NOTDONE})[\\s\\S]{0,${AROUND}}?(?:${COMMIT})`,
  'i',
);

// 「コミットを実施しました」のように commit 自体は済んでいる言及は、"やっていない"標識との
// 近接共起から除く。除かないと「commit を実施し、deploy は未実施」を誤検出する（deploy の
// 未実施が commit に寄ってしまう）。否定形（実施していません/せず）は除かない。
const COMMIT_TOKEN = /(?:git\s+)?commit|コミット/gi;
const DONE_POS = /^\s*を?\s*(?:実施|完了|しました|済み|した)/;
const DONE_NEG = /(?:していません|していない|いなかった|しません|せず|ませんでした)/;
export function maskDoneCommits(text) {
  const s = String(text || '');
  let out = '', last = 0;
  for (const m of s.matchAll(COMMIT_TOKEN)) {
    const end = m.index + m[0].length;
    const after = s.slice(end, end + 16);
    const done = DONE_POS.test(after) && !DONE_NEG.test(after);
    out += s.slice(last, m.index) + (done ? '✔'.repeat(m[0].length) : m[0]);
    last = end;
  }
  return out + s.slice(last);
}

/** 1 turn の本文が「コミットを未実施のまま handoff した」かを判定する。 */
export function detect(text) {
  const t = maskDoneCommits(String(text || ''));
  if (!t) return false;
  // 監査 TODO 文そのもの（毎セッションのプロンプトに入る）と knowledge の pattern 文は再発ではない。
  if (/handoff-audit:585214efa82b1c11/.test(t)) return false;
  if (/実装タスクの完了報告（コミットだけ指示範囲外で保留）/.test(t)) return false;
  return det.test(t);
}

/** 一致した部分文字列（人手分類の根拠）。 */
export function firstMatch(text) {
  const m = det.exec(maskDoneCommits(text));
  return m ? m[0] : '';
}

/** 陽性5件・陰性5件。走査の前に必ず通す。 */
export const CONTROLS = [
  { name: 'P1 指示により未実施', text: '残 TODO ⏳ 次回: `git commit`（指示により未実施）', want: true },
  { name: 'P2 指示範囲外のため保留', text: 'この後の自動進行: なし（目的完了・コミットは指示範囲外のため保留）', want: true },
  { name: 'P3 未コミットのまま', text: '4ファイルは未コミットのまま。コミットが必要なら指示ください。', want: true },
  { name: 'P4 commit/push はしていません', text: 'production への Layer 2 は未実行です。commit / push はしていません。', want: true },
  { name: 'P5 そちらで実施', text: '`git add` / `commit` は仕様通り未実施（そちらで実施）。', want: true },
  { name: 'N1 コミットしました（実施済み）', text: '5ファイルを実装し、`git commit` しました（aba3cba）。', want: false },
  { name: 'N2 commit を実施・deploy のみ言及', text: 'commit を実施し（aba3cba）、deploy は未実施です。', want: false },
  { name: 'N3 レビュー後のコミット依頼（未実施ではない）', text: '変更をコミットし、PR を作成して CI green を確認しました。', want: false },
  { name: 'N4 commit 語が無い', text: '実装は完了し、テストは全件 PASS しました。', want: false },
  { name: 'N5 遠く離れた語（同一 turn でも非近接）', text: 'commit の話はここまで。' + 'あ'.repeat(120) + 'この deploy は行いません。', want: false },
];

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = detect(c.text);
    if (got !== c.want) failures.push({ ...c, got });
  }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

/** 台帳(`handoff-audit-ledger.jsonl`)と transcript(`projects/**`)を走査する。 */
export function scan({ home = os.homedir(), since = Date.now(), readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync, roots = ['projects'] } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => {
    if (!(Date.parse(ts) >= since)) return; // turn の時刻で窓を判定（ファイル mtime の混入を防ぐ）
    const t = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!detect(t)) return;
    rows.push({ src, ts, id, match: firstMatch(t).slice(0, 200), text: t.slice(0, 320) });
  };

  const ledgerFile = path.join(home, '.claude', 'handoff-audit-ledger.jsonl');
  let ledgerTotal = 0, ledgerScanned = 0;
  try {
    for (const line of String(readFile(ledgerFile, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      ledgerTotal++;
      if (!(Date.parse(r.ts) >= since)) continue;
      ledgerScanned++;
      push('ledger', r.ts, String(r.sessionId || '').slice(0, 8), r.excerpt);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  let files = 0, filesScanned = 0, turnsScanned = 0;
  const readdirSafe = (dir) => { try { return readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const walk = (dir) => {
    for (const e of readdirSafe(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      files++;
      let st; try { st = stat(p); } catch { continue; }
      if (st.mtimeMs < since) continue;
      filesScanned++;
      for (const line of String(readFile(p, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.isSidechain) continue;
        const role = rec?.message?.role || rec?.type;
        if (role && role !== 'assistant') continue; // 報告する側＝assistant のみ
        turnsScanned++;
        const c = rec?.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c)
          ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (!text) continue;
        push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(p, '.jsonl').slice(0, 8), text);
      }
    }
  };
  for (const r of roots) walk(path.join(home, '.claude', r));
  return { since: new Date(since).toISOString(), ledger: { total: ledgerTotal, scanned: ledgerScanned }, transcript: { files, filesScanned, turnsScanned }, hits: rows.length, rows };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name}  (want=${c.want} got=${detect(c.text)})`);
    const r = selftest();
    console.log(`selftest: ${r.passed}/${r.total} pass`);
    return r.failures.length ? 1 : 0;
  }
  const i = argv.indexOf('--since');
  const since = i >= 0 && argv[i + 1] ? Date.parse(argv[i + 1]) : Date.now() - 28 * 86400_000;
  console.log(JSON.stringify({ ...scan({ since }), selftest: selftest() }, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) process.exit(main());
