このリポジトリの `SPEC-rule-compliance-loop.md` を読んで、そこに書かれたものを完全実装してください。

## 作るもの
1. `ONBOARDING.md` に §1.1.1 を追記（SPEC §1 の本文どおり。BEGIN/END マーカー方式。既存節は書き換えない）
2. `C:/Users/uers/.claude/CLAUDE.md` に短縮版3行を追記（SPEC §1 の指定位置・指定文面。**長文にしない**）
3. `tools/automation-routes.json` — 既知の自動化経路カタログ（SPEC §2）
4. `tools/handoff-quality-gate.mjs` — Stop hook。`[手渡し判定]` ブロックの構造検査（SPEC §2）
5. `tools/rules-registry.json` — ルール登録簿5件（SPEC §3-1）
6. `tools/rule-compliance-loop.mjs` — 監査ループ本体（SPEC §3-2〜3-6）
7. `tools/handoff-quality-gate.test.mjs` / `tools/rule-compliance-loop.test.mjs` — SPEC §4 の10テスト
8. `docs/rule-compliance-loop.md` — 仕組みの説明と、ルールを1件追加する手順（非エンジニアでも読める日本語）

## 特に落としやすい点（SPEC に書いてあるが強調する）
- **旧 gate の抜け穴 `if ($assistantText -match '(自動化|MCP|CLI).*(試し|失敗|不可|...)') { exit 0 }`
  を絶対に移植しない。** 「試したと言うだけで通る」のが今回の事故原因。
- `[HANDOFF-OK]` タグは廃止。検出したら block して「`[手渡し判定]` を書け」と言う。
- 手渡しが gate を通ったら必ず `~/.claude/handoff-ledger.jsonl` に1行書く。
  これが無いと §3 の「すり抜け」検出ができず、ループが機能しない。
- **すり抜けが1件でもあれば閾値を待たず即 block 昇格。**
- 2026-08-05 の誤検知事例（過去形の完了報告の番号付きリストを block した）を再発させない。
  テスト7がこれ。
- Codex 呼び出しは `--prompt-file` を使う。argv で渡すとバッククォートがコマンド置換で実行される。
- `~/.claude/rules/` にルール本文を置かない（常時ロードでトークンを食う）。
- 既存 hook 登録を消さない。`manual-handoff-detector.ps1` は
  `manual-handoff-detector.ps1.bak-20260828-superseded` にリネームして残す。

## settings.json の変更
`C:/Users/uers/.claude/settings.json` の Stop hook から
`manual-handoff-detector.ps1` の登録を外し、
`node "C:\Users\uers\Downloads\orgiast-claude-rules\tools\handoff-quality-gate.mjs"` を追加する。
SessionStart hook に `node "C:\Users\uers\Downloads\orgiast-claude-rules\tools\rule-compliance-report.mjs"`
（`~/.claude/rule-compliance.md` を inject する薄いスクリプト。無ければ静かに何もしない）を追加する。
**他の hook 登録は1つも消さない・並び替えない。** 編集前に settings.json をバックアップし、
編集後に JSON.parse できることを確認する。

## 実行環境
- Windows。Node は ESM (`.mjs`)。UTF-8 (BOM なし)。
- 日本語を含む PowerShell/cmd を新規に書かない（既存 hook は PowerShell だが、新規は Node で書く）。
- パスに全角（`CLAUDE.md配布`）が入るので、パス結合は `path.join` を使い、
  文字列連結でクォートを組まない。

## 検証（自分で実行して結果を報告する）
- `node --test tools/` が通ること（SPEC §4 の10テスト全部）
- `node tools/rule-compliance-loop.mjs --days 7 --dry-run` が実際の
  `~/.claude/projects/*/*.jsonl` を走査して落ちずにレポートを出すこと。
  **`--dry-run` では `rule-enforcement.json` を書かない。**
- `node tools/handoff-quality-gate.mjs` に SPEC §4 のテスト1の文面を stdin で流して
  `decision: block` が返ること（実際にコマンドを叩いて出力を貼る）
- `settings.json` が編集後も JSON.parse できること
- **本番の `rule-enforcement.json` への書き込みは行わない**（人がレビューしてから初回実行する）
