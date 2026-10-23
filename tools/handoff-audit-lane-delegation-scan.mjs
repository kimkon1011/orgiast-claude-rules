#!/usr/bin/env node
/**
 * handoff-audit-lane-delegation-scan.mjs — 「サブエージェント／他AIレーンへ実装を委譲して
 * 『実行中』で終わる」turn を一次記録から数える読み取り専用ツール。
 *
 * なぜ要るか: 実装を Codex / cheap-code / サブエージェントのレーンへ投げ、
 * 「実行中」「完了通知を待ちます」で報告を閉じる型は、委譲先が実際に編集を着地させたかを
 * 実測しないまま「やった」ことにする事故を生む（このPCでは WSL 不在・gemini 402 で
 * レーンが無言で落ちる既知事象がある）。再発の有無は、台帳(handoff-audit-ledger.jsonl)と
 * transcript(projects/**) を走査すれば資格情報なし・追加権限なしで数えられる。
 *
 * 出典（この型が立ち上がった実物・実測で見つかった9例）:
 *   - 2026-09-23 16aa54ce: `Codexへのコード改修依頼をバックグラウンドで実行中です。`
 *   - 2026-10-12 04:40 f5fc66f7: `実装は Codex レーンに渡して実行中です`
 *   - 2026-10-12 04:41 f5d62573: `Codex に委譲しました（バックグラウンド実行中 ID: b3kw1ixab）`
 *   - 2026-10-12 13:06 3388d0d6: `Phase 1 を Codex（cheap-code:deepseek レーン）に委譲して実行中です`
 *   - 2026-10-12 13:11 861a237a: `委譲レーンは生存しています … 完了通知を待ちます`
 *   - 2026-10-12 13:24 723e6b19: `バックグラウンド実行中 … 次に kim がすること: なし（待機）`
 *   - 2026-10-12 23:43 98282861: `deepseek フォールバックで実行中です … 完了通知を待って`
 *   - 2026-10-12 23:57 0ef50487: `委譲実行中です（executor=fallback:cheap-code:deepseek）`
 *   - 2026-10-14 01:49 523359aa: `Codex に実装を委譲しました（バックグラウンドで実行中）`
 *
 * 再発の定義: 1 turn の本文の中で『委譲を示す語』と『実行中を示す語』が近接（±80 文字以内）して
 *             共起すること。＝実装をレーンに投げて「実行中」のまま報告を終える
 *             （完了を実測していない）型。
 *             監査 TODO 文そのものは除外する（毎セッションのプロンプトに入るため、数えると
 *             自己言及で膨らむ）。委譲はしたが完了している turn（例: `委譲判定: 実装=Codex（完了）`）
 *             は RUNNING 語が無いので近接共起で自動的に落ちる。
 *             定型の注入バナー（`**[委譲判定]** …` は DELEG 語、`**[夜間判定]** …` は RUNNING 語
 *             「待機」を含む）は判定前に除去する。両者が全 turn に必ず入るため、素で見ると
 *             機械的に共起して偽陽性になる（2026-10-15 の実測 FP 6 件中 5 件がこれ）。
 *
 * 使い方:
 *   node tools/handoff-audit-lane-delegation-scan.mjs                    # 既定窓(28日前〜現在)
 *   node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-09-17
 *   node tools/handoff-audit-lane-delegation-scan.mjs --selftest         # 陽性5・陰性5の対照
 *
 * 検出力: 走査結果だけでは「0 件」が「検出できなかった」なのか「本当に無かった」なのか
 *         区別できない。報告する前に --selftest を通し、対照が全通過してから件数を書くこと。
 *
 * 限界: 判定は 1 turn 内の近接共起を要求する。turn をまたいだ言及は取りこぼす。また
 *       「実行中」語が委譲と無関係な文脈（プロセス kill の説明等）で出ても、委譲語が
 *       近傍に無ければ拾わない設計だが、逆に同一 turn 内で両方が別文脈に出る場合は
 *       偽陽性になりうる（運用では人手で分類する）。0 件は「その型が無かった」であって
 *       「委譲して実行中で終えることが皆無だった」ではない。
 *
 * 終了コード: 0 = 走査を完走（0 件でも 0。0 は「測った 0」） / 1 = --selftest が落ちた
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

// 委譲を示す語（DELEG）
const DELEG = [
  'Codex', 'codex-do', '委譲', 'サブエージェント', '他AIレーン', 'エージェントレーン',
  'レーンに渡', 'レーンへ', 'fallback backend', 'cheap-code', 'executor=fallback',
].join('|');
// 実行中を示す語（RUNNING）
// 「完了待ち」「完了を待っ」「終了通知を待」を 2026-10-17 に追加した。従来の「完了通知を待」は
// 「通知」を挟む言い回ししか拾えず、`実装レーン（codex-do → Gemini フォールバック）の完了待ちです。`
// のような variant を取りこぼしていた（実測: 台帳+transcript で 25 hits → 38 hits、+13 行＝約 6 turn。
// うち 1 行は検証記録が検出語を引用した自己引用で、恒久修正は deferral-scan 側の PR #816）。
const RUNNING = [
  '実行中', 'バックグラウンドで実行', 'バックグラウンド実行', '稼働開始',
  '完了通知を待', '完了待ち', '完了を待っ', '終了通知を待', '待機', '走らせて',
].join('|');

// 委譲語と実行中語の許容距離（文字数）
const AROUND = 80;
const det = new RegExp(
  `(?:${DELEG})[\\s\\S]{0,${AROUND}}?(?:${RUNNING})|(?:${RUNNING})[\\s\\S]{0,${AROUND}}?(?:${DELEG})`,
  'i',
);

// 監査 TODO 文そのもの（毎セッションのプロンプトに入る）。全角/半角スラッシュ両方を除外する
// （要件は半角 `/` を指定しているが、プロンプト本文では全角 `／` でも現れるため両対応にする）。
const AUDIT_TODO = /サブエージェント[/／]他AIレーンへ実装を委譲して/;

// 全 turn に必ず入る定型バナー。`**[委譲判定]** …` は DELEG 語（委譲）、
// `**[夜間判定]** …` は RUNNING 語（待機）を含むため、除かないと機械的に共起して偽陽性になる。
// 行末まで除去する（バナーは 1 行に収まる）。
const BANNER = /\*\*\[(?:委譲判定|夜間判定)\]\*\*[^\n]*/g;

/** 定型バナー行を空白に置換した本文（判定・根拠表示はこちらを使う）。 */
export function stripBanners(text) {
  return String(text || '').replace(BANNER, ' ').replace(/待機プロセス/g, ' ');
}

/** 1 turn の本文が「委譲して実行中で終えた」型かを判定する。 */
export function detect(text) {
  const t = stripBanners(text);
  if (!t.trim()) return false;
  if (AUDIT_TODO.test(t)) return false;
  return det.test(t);
}

/** 一致した部分文字列（人手分類の根拠）。バナー由来の一致は根拠にしない。 */
export function firstMatch(text) {
  const m = det.exec(stripBanners(text));
  return m ? m[0] : '';
}

/** 陽性5件・陰性5件。走査の前に必ず通す。 */
export const CONTROLS = [
  { name: 'P1 バックグラウンド実行中 ID', text: 'Codex に委譲しました（バックグラウンド実行中 ID: b3kw1ixab）。', want: true },
  { name: 'P2 レーンに渡して実行中', text: '実装は Codex レーンに渡して実行中です。完了通知を待ちます。', want: true },
  { name: 'P3 executor=fallback:cheap-code', text: '委譲実行中です（executor=fallback:cheap-code:deepseek）。完了通知を待ちます。', want: true },
  { name: 'P4 サブエージェント委譲＋待機', text: 'サブエージェントに実装を委譲して実行中です。次に kim がすること: なし（待機）。', want: true },
  { name: 'P5 Phase 委譲＋完了通知待ち', text: 'Phase 1 を Codex レーンに委譲して実行中です。完了通知を待って検証します。', want: true },
  { name: 'N1 委譲して実装完了', text: 'Codex に委譲して実装完了、テスト全件 PASS しました。', want: false },
  { name: 'N2 委譲判定（完了）', text: '委譲判定: 実装=Codex（完了）→ 監督 verify 完了。', want: false },
  { name: 'N3 実行中語のみ（委譲語なし）', text: '実行中のプロセスは kill されるため run_in_background は禁止です。', want: false },
  { name: 'N4 委譲語も実行中語も無い', text: '実装は完了し、テストは全件 PASS しました。', want: false },
  { name: 'N5 遠く離れた語（同一 turn でも非近接）', text: 'Codex に委譲しました。' + 'あ'.repeat(200) + 'この処理が実行中かは不明です。', want: false },
  { name: 'N6 注入バナーのみ（委譲判定＋夜間判定の共起）', text: '実装は数行なので自分で行います。\n**[委譲判定]** 自分で実施（理由: 数行/設定/設計試行錯誤中）\n**[夜間判定]** 即時実行（理由: 締切が近く、待機理由なし）\n', want: false },
  { name: 'P6 バナー＋本物の委譲実行中は陽性のまま', text: '**[委譲判定]** 実装=Codex（理由: 定型の量産）\n**[夜間判定]** 即時実行（理由: 待機理由なし）\nCodex に委譲しました（バックグラウンド実行中 ID: b3kw1ixab）。\n', want: true },
  // 2026-10-15 02:14:23Z / 700b6033 の実文（従来語彙では「完了通知を待」に一致せず取りこぼしていた）。
  { name: 'P7 レーン完了待ち（通知を挟まない variant）', text: '実装レーン（codex-do → Gemini フォールバック）の完了待ちです。Gemini 側はシェル実行が拒否されているため、終了後に成果物を確認します。', want: true },
];

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = detect(c.text);
    if (got !== c.want) failures.push({ ...c, got });
  }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

/** tool_result ではない、本物の user プロンプトか。 */
function isRealUserPrompt(rec) {
  if (rec?.type !== 'user') return false;
  const c = rec?.message?.content;
  if (typeof c === 'string') {
    return ![
      'Stop hook feedback:',
      '<task-notification>',
      '<system-reminder>',
      '[HANDOFF-REGRET]',
    ].some((prefix) => c.startsWith(prefix));
  }
  return Array.isArray(c)
    && c.some((b) => b?.type === 'text')
    && !c.some((b) => b?.type === 'tool_result');
}

/** 同じ user-turn 内で委譲を起動し、hit 後にその完了結果または完了通知を受け取ったか。 */
function completedCodexDoInTurn(records, hitIndex) {
  let start = 0;
  for (let i = hitIndex - 1; i >= 0; i--) {
    if (isRealUserPrompt(records[i])) {
      start = i + 1;
      break;
    }
  }
  const end = records.findIndex((rec, i) => i > hitIndex && isRealUserPrompt(rec));
  const limit = end < 0 ? records.length : end;
  const delegationToolUseIds = new Set();
  for (let i = start; i < limit; i++) {
    const rec = records[i];
    const c = rec?.message?.content;
    if (rec?.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use'
          && b?.name === 'Bash'
          && /codex-do\.mjs|codex\s+exec\b|cheap-code\.mjs/.test(String(b?.input?.command || ''))) {
          delegationToolUseIds.add(b.id || '*');
        }
      }
    }
  }
  for (let i = hitIndex + 1; i < limit; i++) {
    const rec = records[i];
    const c = rec?.message?.content;
    if (rec?.type === 'user' && Array.isArray(c)
      && c.some((b) => b?.type === 'tool_result'
        && !/(?:\b(?:running in background|background with ID)\b|バックグラウンドで実行中\s*ID)/i.test(String(b?.content || ''))
        && (b.tool_use_id ? delegationToolUseIds.has(b.tool_use_id) : delegationToolUseIds.size > 0))) return true;
    if (rec?.type === 'user' && typeof c === 'string'
      && c.includes('<task-notification>')
      && c.includes('<status>completed</status>')) {
      const toolUseId = c.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1];
      if (toolUseId && delegationToolUseIds.has(toolUseId)) return true;
    }
  }
  return false;
}

/** 台帳(`handoff-audit-ledger.jsonl`)と transcript(`projects/**`)を走査する。 */
export function scan({ home = os.homedir(), since = Date.now(), readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync, roots = ['projects'] } = {}) {
  const rows = [];
  const push = (src, ts, id, text, inTurn = false) => {
    if (!(Date.parse(ts) >= since)) return; // turn の時刻で窓を判定（ファイル mtime の混入を防ぐ）
    const raw = String(text || '');
    // 改行を潰す前に判定する（バナー除去が行単位のため。潰した後では行末が拾えない）。
    if (!detect(raw)) return;
    const t = stripBanners(raw).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    rows.push({ src, ts, id, match: firstMatch(raw).replace(/\s+/g, ' ').slice(0, 200), text: t.slice(0, 320), inTurn });
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
      const records = [];
      for (const line of String(readFile(p, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.isSidechain) continue;
        records.push(rec);
      }
      for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
        const rec = records[recordIndex];
        const role = rec?.message?.role || rec?.type;
        if (role && role !== 'assistant') continue; // 報告する側＝assistant のみ
        turnsScanned++;
        const c = rec?.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c)
          ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (!text) continue;
        push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(p, '.jsonl').slice(0, 8), text,
          completedCodexDoInTurn(records, recordIndex));
      }
    }
  };
  for (const r of roots) walk(path.join(home, '.claude', r));
  return {
    since: new Date(since).toISOString(),
    ledger: { total: ledgerTotal, scanned: ledgerScanned },
    transcript: { files, filesScanned, turnsScanned },
    hits: rows.length,
    recurrences: rows.filter((r) => !r.inTurn).length,
    inTurnHits: rows.filter((r) => r.inTurn).length,
    rows,
  };
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
