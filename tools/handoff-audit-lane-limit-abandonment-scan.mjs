#!/usr/bin/env node
/**
 * handoff-audit-lane-limit-abandonment-scan.mjs — 「他AIレーンの usage limit / cooldown を理由に
 * 作業を止めた（または Claude 本体・次回へ回した）」turn を一次記録から数える読み取り専用ツール。
 *
 * なぜ要るか: 既存の handoff-audit-lane-delegation-scan は『委譲して実行中で終える』型だけを見る。
 * レーンの上限（Codex の usage limit / クールダウン、429、利用枠切れ）を理由に
 * 「修復不可」「本体で続行」「次回に回す」で閉じる型は別物で、しかも語彙が英日混在
 * （usage limit / クールダウン / 利用枠切れ）なので専用の検出器が無かった。
 * 2026-10-25 の再発監査で、前回監査（4101244d79302da4）の語彙が cooldown / 修復不可 を
 * 含まず原文を拾えていなかったことが分かったため、判定をコードに固定する。
 *
 * 出典（実文）: 2026-10-23T10:31:41.918Z / 55e59df6
 *   `[LANE-REPAIR] codex: 修復不可 試行: … 3回とも「Codex usage limit クールダウン中」…
 *    代わりの DeepSeek が実装しました。`
 *   → nightly が rule 13/12 違反（lane-doctor を試さず修復不可と断定）と判定。
 *
 * 再発の定義: 1 turn の本文で、上限語（LIMIT）の±250文字以内にレーン語（LANE）と
 *             停止/先送り語（ABANDON）が同時に現れること。
 *             ただし次のどれかがある turn は除外する（正当な処理）:
 *               - `[LANE-FALLBACK]` 付きの明示的フォールバック
 *               - `lane-doctor.mjs` の実行記録
 *               - `[LANE-REPAIR] <lane>: 修復済み …`
 *             監査 TODO 文そのもの（毎セッションのプロンプトに入る）は除外する。
 *
 * 使い方:
 *   node tools/handoff-audit-lane-limit-abandonment-scan.mjs --since 2026-10-23T10:31:41Z
 *   node tools/handoff-audit-lane-limit-abandonment-scan.mjs --selftest
 *
 * 限界: 近接共起に依存するため、極端な言い換え（例: 「枠が終わったので次回」）は取りこぼす。
 *       0 件は「測った 0」であり、全期間の絶対 0 ではない。他人 PC・削除済みログは対象外。
 *       結果は機械の候補であり、最終判定は人手で行う（除外語を含む turn も候補として出す）。
 *
 * 終了コード: 0 = 走査完走（0 件でも 0） / 1 = --selftest 失敗
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const LANE = /Codex|codex-do|他AI|レーン|サブエージェント|Gemini|DeepSeek|GLM|Kimi/i;
export const LIMIT = /usage limit|クールダウン|cooldown|利用上限|上限に達|上限到達|レート上限|RESOURCE_EXHAUSTED|\b429\b|利用枠|枠切れ|使い切/i;
export const ABANDON = /修復不可|LANE-ABANDON|作業を止|止め(?:る|ます)|停止|本体で|次回|後回し|中断|自分で実装|自分で直|保留|代行/;
/** 正当な処理（修復・明示フォールバック）。除外理由として返す。 */
export const EXEMPT = [
  { id: 'fallback', re: /\[LANE-FALLBACK\]/ },
  // `lane-doctor --probe`（.mjs 省略）の実行記録も修復の証拠として扱う（2026-10-23 bc7b1727 実文）。
  { id: 'doctor', re: /lane-doctor(?:\.mjs)?(?:\s+--probe)?/ },
  { id: 'repaired', re: /\[LANE-REPAIR\][^\n]*修復済み/ },
];
/** 監査 TODO 文そのもの（毎セッションのプロンプトに入るので数えない）。 */
const AUDIT_TODO = /他AIレーン（Codex等）の usage limit \/ cooldown で作業が止まった/;

const WINDOW = 250;

/** 一致した近接窓と除外理由を返す。 */
export function inspect(text) {
  const t = String(text || '');
  if (!t.trim() || AUDIT_TODO.test(t)) return { hit: false };
  for (const m of t.matchAll(new RegExp(LIMIT.source, 'gi'))) {
    const s = Math.max(0, m.index - WINDOW);
    const window = t.slice(s, m.index + m[0].length + WINDOW);
    if (!LANE.test(window) || !ABANDON.test(window)) continue;
    const exempt = EXEMPT.find(e => e.re.test(window) || e.re.test(t));
    return { hit: true, match: window.replace(/\s+/g, ' ').trim().slice(0, 220), exempt: exempt?.id || '' };
  }
  return { hit: false };
}

export function detect(text) {
  const r = inspect(text);
  return r.hit && !r.exempt;
}

/** 陽性4・陰性5。走査の前に必ず通す。 */
export const CONTROLS = [
  {
    name: 'P1 原文（修復不可＋usage limit クールダウン中）',
    text: '[LANE-REPAIR] codex: 修復不可 試行: このセッションで codex-do を3回試し、3回とも「Codex usage limit クールダウン中」と出た。代わりの DeepSeek は動いている。',
    want: true,
  },
  {
    name: 'P2 上限で次回に回す',
    text: 'Codex が usage limit に達したので、この修正は次回のセッションに回します。',
    want: true,
  },
  {
    name: 'P3 利用枠切れで本体対応',
    text: 'Gemini の利用枠切れのため、今回の実装は Claude 本体で進めます。',
    want: true,
  },
  {
    name: 'P4 429 で作業を止める',
    text: 'deepseek が 429 を返すため、レーンの作業はここで止めます。',
    want: true,
  },
  {
    name: 'N1 フォールバックして完了',
    text: 'Codex の usage limit を検出したので DeepSeek にフォールバックし、実装とテストまで完了しました。',
    want: false,
  },
  {
    name: 'N2 上限を検出して修復済み',
    text: '[LANE-REPAIR] codex: 修復済み usage limit の cooldown を lane-doctor.mjs --probe で確認し、deepseek へ委譲した。',
    want: false,
  },
  {
    name: 'N3 明示フォールバック宣言',
    text: '[LANE-FALLBACK] codex が usage limit で停止。deepseek が生存しているため委譲して完了した。',
    want: false,
  },
  {
    name: 'N4 語が離れている（別文脈）',
    text: 'レーンの説明です。' + 'あ'.repeat(300) + ' usage limit の単体テストを追加しました。次回に回す項目はありません。',
    want: false,
  },
  {
    name: 'N5 監査 TODO 文そのもの',
    text: '9. [handoff-audit:13f5d2c0ea6be788] 他AIレーン（Codex等）の usage limit / cooldown で作業が止まった — この handoff が再発していないかを実物で検証し結果を記録する。',
    want: false,
  },
];

export function selftest() {
  const failures = CONTROLS.filter(c => detect(c.text) !== c.want).map(c => ({ ...c, got: detect(c.text) }));
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

const textOf = rec => {
  const c = rec?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
};

/** 台帳と transcript を走査する（mtime で窓を先に絞る）。 */
export function scan({ home = os.homedir(), since = Date.now(), roots = ['projects', path.join('cheap-code-worker', 'projects')] } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => {
    if (!(Date.parse(ts) >= since)) return;
    const r = inspect(text);
    if (!r.hit) return;
    rows.push({ src, ts, id, exempt: r.exempt, match: r.match, text: String(text).replace(/\s+/g, ' ').slice(0, 320) });
  };
  const ledgers = {};
  for (const name of ['handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl', 'handoff-audit-deferral-ledger.jsonl', 'course-corrections-ledger.jsonl']) {
    const file = path.join(home, '.claude', name);
    let total = 0, inWindow = 0;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        total++;
        const ts = r.ts || r.t;
        if (!(Date.parse(ts) >= since)) continue;
        inWindow++;
        push(name, ts, String(r.sessionId || r.gate || '').slice(0, 12), JSON.stringify(r));
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    ledgers[name] = { total, inWindow };
  }
  let files = 0, filesScanned = 0, turns = 0;
  const walk = dir => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      files++;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < since) continue;
      filesScanned++;
      let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.isSidechain) continue;
        const role = rec?.message?.role || rec?.type;
        if (role && role !== 'assistant') continue;
        turns++;
        push('transcript', rec.timestamp, path.basename(p, '.jsonl').slice(0, 8), textOf(rec));
      }
    }
  };
  for (const r of roots) walk(path.join(home, '.claude', r));
  return {
    since: new Date(since).toISOString(),
    ledgers,
    transcript: { files, filesScanned, turns },
    hits: rows.length,
    recurrences: rows.filter(r => !r.exempt).length,
    exemptHits: rows.filter(r => r.exempt).length,
    rows,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name} (want=${c.want})`);
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
