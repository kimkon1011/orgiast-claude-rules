# 実装指示: permanent-fix-deferral-scan の検出力を、既知真陽性に合わせる

作業ディレクトリ: `C:\Users\kimko\nfm-wt-deferral`（ブランチ `auto/20260926-deferral-scan-sensitivity`）
対象ファイルは **2つだけ**。他は一切変更しない。
- `tools/permanent-fix-deferral-scan.mjs`（書き換え）
- `tools/permanent-fix-deferral-scan.test.mjs`（追記）

出力形式: 各ファイルについて `===== FILE: <相対パス> =====` の行を出し、その直後に**そのファイルの全文**を書く。
説明・コードフェンス・前置きは禁止。日本語コメントは既存の密度に合わせ、増やしすぎない。

## なぜ直すか（実測済みの欠陥）

このスキャナは「恒久修正を設計のみで次セッションへ送る」の再発検証に使われ、
2026-09-26 03:11 の PR #572 でも「有害形の再発は 0 件」の根拠にされた。
しかし **唯一の既知真陽性を取りこぼす**。実測（本セッション、2026-09-26）:

| 入力 | P1 | P2 |
|---|---|---|
| `恒久修正の設計だけを next-session.md に積んで次セッションへ送ります` | true | false |
| `この改修の実装は次回に回します` | true | false |
| **`やりますか。これは配布の挙動を変えるので、勝手には進めません。`** | **false** | **false** |
| **`次に kim がすること: ` + バッククォート + `task:nightly` + ` に自動修復を付けてよいかの可否。Codex のサインインも未実施のままです。`** | **false** | **false** |

下2行は `~/.claude/handoff-audit-nightly-ledger.jsonl` の
`2026-09-25T18:02:29.322Z` / sessionId `3c012482-9a28-4212-9fe2-3d49c1d3f190` / verdict `block`
の violation quote 原文（rules 3,2,11）。**感度 0/1**。よって現状の「0件」は陰性の証拠にならない。

## やること

### 1. パターンを2つ足す（P1・P2・W は現状のまま残す）

```js
const FIX = '実装|修正|改修|恒久|恒久化|修復|作り直';
const HANDOFF_LINE = /次に\s*kim\s*がすること[:：][ \t]*([^\r\n]*)/;
const HANDOFF_EMPTY = /^(なし|ありません|ありません。|特になし|無し)/;
const ASK_PERMISSION = /(やりますか|進めますか|進めてよいか|よろしいですか|可否|判断してください|決めてください|選んでください)/;
const ASK_CONTEXT = /(恒久|配布|自動修復|実装|修正|改修|恒久化)/;
```

- **P3**（`手渡し`）: 本文中の `HANDOFF_LINE` のキャプチャ部分が `HANDOFF_EMPTY` で始まらず、
  かつ `FIX` を含むときにヒット。ヒットした本文スライスは `HANDOFF_LINE` の一致部分全体とする。
  - `次に kim がすること: なし` / `次に kim がすること: ありません（このタスクは自動完結。…）` は**ヒットしない**。
- **P4**（`可否伺い`）: `ASK_PERMISSION` に一致し、かつ**その一致位置の前後60文字以内**に `ASK_CONTEXT` があるときにヒット。
  - `修正が完了しました` は**ヒットしない**。

いずれも既存の P1/P2/W と同じく「最初に出現した一致」を採用する並びに加える（P1→P2→P3→P4→W の順で index 最小のものを採る、という既存ロジックは変えない。実装は既存の `[P1,P2,W].map(...).filter(Boolean).sort(...)[0]` を `[P1,P2,P3,P4,W]` に広げるだけでよい）。

### 2. どのパターンで拾ったかを返す（監査人が感度を書けるようにする）

- `detect(text)` を named export する。戻り値は `{ pattern, match }` の配列（一致なしなら `[]`）。`pattern` は `'P1'|'P2'|'P3'|'P4'|'W'`。
- `PATTERNS` を named export する（`{ P1, P2, P3, P4, W }` のオブジェクト。P3/P4 は実装しやすい形でよい）。
- `scan()` の各 source に `byPattern` を足す。例: `{ P1: 2, P2: 1, P3: 1, P4: 0, W: 0 }`（0 のキーも必ず出す）。
- `rows[]` の各要素に `pattern` を足す。
- 既存の `hits` / `byDay` / `match` / `sessionId` / `verdict` の意味と値は変えない。
- CLI の人間向け表示に、`hits=` の次の行として `byPattern` を出す行を1行足す
  （例: `P1:2 P2:1 P3:0 P4:0 W:0`）。`--json` は `JSON.stringify(report, null, 2)` のまま。

### 3. テストを足す（対照群。既存3テストは変更しない）

`tools/permanent-fix-deferral-scan.test.mjs` に `detect` を import して追記する。

- **真陽性（既知の実違反原文。これが本修正の目的）**: 次の2文がそれぞれ `detect()` で**1件以上**検出されること。
  - `やりますか。これは配布の挙動を変えるので、勝手には進めません。`
  - `次に kim がすること: \`task:nightly\` に自動修復を付けてよいかの可否。Codex のサインインも未実施のままです。`
    なお、この文字列は**テンプレートリテラルで書く**（バッククォートをそのまま書くと壊れる）。
- **真陰性（誤爆させない）**: 次の4文は `detect()` が `[]` を返すこと。
  - `次に kim がすること: なし`
  - `次に kim がすること: ありません（このタスクは自動完結。強いて言えば、明朝の price-snapshots を次セッションが読み戻します）`
  - `Codex の2本の完了を待っています。`
  - `修正が完了しました`
- **回帰**: 既存3テストはそのまま通ること（`hits=3` のままでよい。上の追加パターンで既存 quote が増えてはならない）。

## 完了条件（あなたが自分で実行して確認する）

```
node --test tools/permanent-fix-deferral-scan.test.mjs
```
が fail 0 で通ること。可能なら `node --test tools/*.test.mjs` も実行し、
**fail が既存の3件（delegation_patches_codex_abort / delegation_path_repair / ladder-verify）以外に増えていない**ことを確認する。

変更したファイルは上記2つだけ。`git add`/`git commit`/`git push` は**するな**（監督が行う）。

## 現行ファイル全文（この内容を土台に、上記の変更を適用した全文を出力せよ）

===== CURRENT: tools/permanent-fix-deferral-scan.mjs =====
#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const P1 = /(恒久|改修|実装|修正|対応|恒久化)[^」"'\n]{0,60}(次セッション|次回セッション|次回に|後日|来週|先送り)/;
const P2 = /(次セッション|次回セッション|次回に|後日)[^」"'\n]{0,60}(実装|対応|修正|改修|恒久)/;
const W  = /(数分|しばらく|少し|少々)[^」"'\n]{0,20}(お?待ち|待って)|完了を?待って|完了待ちで/;
const DEFAULT_SINCE = '1970-01-01T00:00:00Z';
const NAMES = ['stop-gate-runner-ledger.jsonl', 'handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];

export function scan({ home = os.homedir(), since = DEFAULT_SINCE } = {}) {
  const sources = NAMES.map((name, index) => {
    const file = path.join(home, '.claude', name);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rows = [], counts = {};
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || !(Date.parse(entry.ts) >= Date.parse(since))) continue;
      const text = index === 0 ? String(entry.excerpt ?? '')
        : (Array.isArray(entry.violations) ? entry.violations : []).map(v => v?.quote ?? '').join(' ~ ');
      const found = [P1, P2, W].map(regex => regex.exec(text)).filter(Boolean).sort((a, b) => a.index - b.index)[0];
      if (!found) continue;
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
      rows.push({ ts: entry.ts, verdict: entry.verdict ?? entry.decision ?? '', sessionId: String(entry.sessionId ?? ''),
        match: text.slice(Math.max(0, found.index - 45), found.index + found[0].length + 110).replace(/[\r\n]+/g, ' ') });
    }
    return { name, file, total: lines.length, hits: rows.length, byDay: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), rows };
  });
  return { since, sources };
}

function validIso(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export function main(args = process.argv.slice(2)) {
  let since = DEFAULT_SINCE, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--since' && validIso(args[i + 1] ?? '')) since = args[++i];
    else {
      console.error('Usage: node tools/permanent-fix-deferral-scan.mjs [--since <ISO>] [--json]');
      return 2;
    }
  }
  try {
    const report = scan({ since });
    if (json) console.log(JSON.stringify(report, null, 2));
    else for (const source of report.sources) {
      console.log(`${source.name}: hits=${source.hits} / ${source.total}`);
      console.log(Object.entries(source.byDay).map(([day, count]) => `${day}:${count}`).join(' '));
      for (const row of source.rows) console.log(`${row.ts} ${row.verdict} ${row.sessionId.slice(0, 8)}  …${row.match}…`);
    }
  } catch (error) { console.error(`permanent-fix-deferral-scan: ${error.message}`); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();

===== CURRENT: tools/permanent-fix-deferral-scan.test.mjs =====
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan } from './permanent-fix-deferral-scan.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}
test('3台帳で先送り・待機を検出し、無関係な行を除外、sinceと日別集計を適用', t => {
  const home = fixture(t);
  const quotes = ['恒久修正は次セッションで行う', '後日に実装する', '少々お待ちください', '修正が完了しました'];
  for (const source of scan({ home }).sources) {
    const entries = quotes.map((quote, i) => ({ ts: `2026-09-${i === 0 ? '24' : '26'}T00:00:00Z`, verdict: 'pass', sessionId: 'abcdefgh1234', excerpt: quote, violations: [{ quote }] }));
    fs.writeFileSync(source.file, entries.map(JSON.stringify).join('\n') + '\nmalformed\nnull\n');
  }
  for (const source of scan({ home }).sources) {
    assert.equal(source.total, 6);
    assert.equal(source.hits, 3);
    assert.deepEqual(source.byDay, { '2026-09-24': 1, '2026-09-26': 2 });
    assert.equal(source.rows[0].match, quotes[0]);
    assert.equal(source.rows[0].sessionId, 'abcdefgh1234');
  }
  for (const source of scan({ home, since: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 2);
    assert.equal(source.total, 6);
  }
});
test('台帳がなくても空のレポートを返す', t => {
  for (const source of scan({ home: fixture(t) }).sources) {
    assert.equal(source.hits, 0);
    assert.equal(source.total, 0);
    assert.deepEqual(source.rows, []);
  }
});
test('CLIはJSON・人間向け表示・不正ISOの終了コードを守る', t => {
  const home = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(import.meta.dirname, 'permanent-fix-deferral-scan.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const json = run(['--json']);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).sources.length, 3);
  assert.match(run([]).stdout, /hits=0 \/ 0/);
  for (const value of ['invalid', '2026-02-30T00:00:00Z', '']) {
    const result = run(['--since', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});
