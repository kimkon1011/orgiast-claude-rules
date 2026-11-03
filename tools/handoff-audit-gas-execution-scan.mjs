#!/usr/bin/env node
/**
 * GAS の実行・本番反映を人手や別 PC に渡した turn を、台帳と transcript から数える。
 * 読み取り専用。検出語同士が 120 文字以内にある場合だけ再発候補とする。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const AROUND = 120;
const HANDOFF = /代行|依頼|お願い|してください|してもら|待ち|待って|kim-PC|kim さんに.{0,40}必要なこと|手作業|人手|担当者/gi;
const GAS_DIRECT = /clasp run|clasp 経由|clasp の実行|コマンドキュー|CommandQueue|▶\s?実行|\bgas\s*\(/gi;
const GAS_NEAR_ACTION = /GAS/gi;
const ACTION = /実行|反映/gi;
const SELF_QUOTE = /\[handoff-audit:2a521d8efb465e3a\]|GAS の関数実行が要る/;
const RESOLVED = /頼まずに|人の操作なし|人に頼ま|kim の操作ゼロ|人手は不要|手作業は不要|この PC から実行して完了|こちらから実行して完了/;
const BANNER = /^.*\*\*\[委譲判定\]\*\*.*$/gm;

export function stripBanners(text) {
  return String(text || '').replace(BANNER, ' ');
}

function matches(re, text) {
  return [...text.matchAll(re)].map((m) => ({ index: m.index, end: m.index + m[0].length, text: m[0] }));
}

function gasMatches(text) {
  const found = matches(GAS_DIRECT, text);
  const actions = matches(ACTION, text);
  for (const gas of matches(GAS_NEAR_ACTION, text)) {
    if (actions.some((action) => Math.max(0, action.index - gas.end, gas.index - action.end) <= 12)) {
      found.push(gas);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function distance(a, b) {
  return Math.max(0, b.index - a.end, a.index - b.end);
}

function detectedPair(text) {
  const gases = gasMatches(text);
  const handoffs = matches(HANDOFF, text);
  for (const gas of gases) {
    for (const handoff of handoffs) {
      if (distance(gas, handoff) <= AROUND) return { gas, handoff };
    }
  }
  return null;
}

/** 1 assistant turn が GAS 実行を人手・別 PC に渡した型か。 */
export function detect(text) {
  const t = stripBanners(text);
  if (!t.trim() || SELF_QUOTE.test(t) || RESOLVED.test(t)) return false;
  return Boolean(detectedPair(t));
}

/** 人手分類用に、共起した二語を含む最小範囲を返す。 */
export function firstMatch(text) {
  const t = stripBanners(text);
  if (SELF_QUOTE.test(t) || RESOLVED.test(t)) return '';
  const pair = detectedPair(t);
  if (!pair) return '';
  const start = Math.min(pair.gas.index, pair.handoff.index);
  const end = Math.max(pair.gas.end, pair.handoff.end);
  return t.slice(start, end);
}

export const CONTROLS = [
  { name: 'P1 clasp 不可・CommandQueue 代行待ち', text: 'clasp 経由の実行・ログ取得は GCP プロジェクト未設定で不可でした…実行時の確定証拠は kim-PC への CommandQueue 代行（依頼済み）待ち', want: true },
  { name: 'P2 コマンドキューを別PCへ代行', text: 'GAS をこちらから直接動かす経路は、どれも使えませんでした。…コマンドキュー：cr@ には書き込み権限がありません。そのため…kim-PC にコマンドキューへの投入を代行してもらう形に', want: true },
  { name: 'P3 PowerShell で gas 関数実行をお願い', text: 'お願い：VSCode のターミナル（PowerShell）に次の1行を貼って Enter\nnode --input-type=module -e "…gas(\'runJob\',{})…"', want: true },
  { name: 'P4 本番反映を担当者へ', text: '### 1. 本番への即時反映（booth-production-app 側の担当者が実施） 1. GAS エディタ、または clasp run で CaseIntake_setupTrigger を1回実行します。', want: true },
  { name: 'P5 コマンドキュー実行で kim の操作', text: '制作アプリのコマンド実行（今回の当日アプリ項目追加など） | コマンドキュー…kim さんに一度だけ必要なこと', want: true },
  { name: 'P6 GAS エディタの実行クリック', text: 'GAS エディタの関数一覧で ▶ 実行 をクリックしてください', want: true },
  { name: 'N1 このPCから完了', text: 'kim-PC に頼まずにこの PC だけで動かせるようになりました。…この PC から実行して完了しています。', want: false },
  { name: 'N2 操作依頼なし', text: '[HANDOFF-INFO-OK]（お願いしたい操作はありません）', want: false },
  { name: 'N3 監査TODO引用', text: '[handoff-audit:2a521d8efb465e3a] GAS の関数実行が要る — この handoff が再発していないかを実物で検証し', want: false },
  { name: 'N4 CommandQueue 登録済み', text: 'CommandQueue に登録してテストを追加しました。テストは全件 pass。', want: false },
  { name: 'N5 clasp pull', text: 'GAS のトリガー一覧を読むために clasp pull しました。', want: false },
  { name: 'N6 委譲判定バナーのみ', text: '**[委譲判定]** 実装=Codex（理由: 定型）', want: false },
];

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = detect(c.text);
    if (got !== c.want) failures.push({ ...c, got });
  }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

/** 2種の台帳と ~/.claude/projects 以下の transcript を走査する。 */
export function scan({ home = os.homedir(), since = Date.now(), readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync, roots = ['projects'] } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => {
    if (!(Date.parse(ts) >= since)) return;
    const raw = String(text || '');
    if (!detect(raw)) return;
    const normalized = stripBanners(raw).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    rows.push({ src, ts, id, match: firstMatch(raw).replace(/\s+/g, ' ').slice(0, 200), text: normalized.slice(0, 320) });
  };

  const ledgerNames = ['handoff-audit-ledger.jsonl', 'stop-gate-runner-ledger.jsonl'];
  const perFile = {};
  let ledgerTotal = 0;
  let ledgerScanned = 0;
  for (const name of ledgerNames) {
    const counts = { total: 0, scanned: 0 };
    perFile[name] = counts;
    const file = path.join(home, '.claude', name);
    try {
      for (const line of String(readFile(file, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        counts.total++; ledgerTotal++;
        if (!(Date.parse(rec.ts) >= since)) continue;
        counts.scanned++; ledgerScanned++;
        const body = [rec.excerpt, rec.text].filter((v) => typeof v === 'string' && v).join('\n');
        push(name === ledgerNames[0] ? 'ledger' : 'runner-ledger', rec.ts, String(rec.sessionId || rec.id || '').slice(0, 8), body);
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  let files = 0, filesScanned = 0, turnsScanned = 0;
  const readdirSafe = (dir) => { try { return readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const walk = (dir) => {
    for (const entry of readdirSafe(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      files++;
      let st; try { st = stat(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      filesScanned++;
      for (const line of String(readFile(file, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.isSidechain) continue;
        const role = rec?.message?.role || rec?.type;
        if (role && role !== 'assistant') continue;
        turnsScanned++;
        const content = rec?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (text) push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(file, '.jsonl').slice(0, 8), text);
      }
    }
  };
  for (const root of roots) walk(path.join(home, '.claude', root));
  return {
    since: new Date(since).toISOString(),
    ledger: { total: ledgerTotal, scanned: ledgerScanned, perFile },
    transcript: { files, filesScanned, turnsScanned },
    hits: rows.length,
    rows,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name}  (want=${c.want} got=${detect(c.text)})`);
    const result = selftest();
    console.log(`selftest: ${result.passed}/${result.total} pass`);
    return result.failures.length ? 1 : 0;
  }
  const index = argv.indexOf('--since');
  const since = index >= 0 && argv[index + 1] ? Date.parse(argv[index + 1]) : Date.now() - 28 * 86400_000;
  console.log(JSON.stringify({ ...scan({ since }), selftest: selftest() }, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) process.exit(main());
