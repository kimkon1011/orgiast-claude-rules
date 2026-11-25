# 仕上げ3件（テスト赤1件 + 重複検出器の整理 + gateインストーラ）

現状（実測）:
- `node --test tools/` → **13件中12件pass、1件赤**: `11 ledger excerptが非空`
- `node tools/rule-detector-precision.mjs` → 全ルール precision 100%。ただし
  `delegate-implementation` は **recall 20%**（5件中1件しか検出しない）
- `node tools/rule-compliance-loop.mjs --days 7 --dry-run` は正しく動作。
  すり抜けは「計測不能（ledger 未生成）」と正しく表示。enforcement は未書き込み。

## 作業1【必須】テスト11の赤を直す — ledger の excerpt が常に空

`tools/handoff-quality-gate.mjs` の `main()`:
```js
excerpt: (result.text || '').slice(0, 200)
```
`runGate()` の戻り値に `text` が無い経路が残っているため、
`handoff-ledger.jsonl` の `excerpt` が空文字で書かれる。

**なぜ致命的か**: すり抜け事例から gate の修正案を生成する仕組み（SPEC §3-4）は
excerpt を材料にする。空だとループの「改善」部分が永久に空回りする。
「動いているように見えて中身が無い」典型なので必ず直す。

- `runGate()` が **どの return 経路でも** 検査した assistant text を返すようにする
  （`decision: 'pass', reason: '手渡しなし'` の早期 return も含む）
- テスト11が green になること
- **併せて**: excerpt が空のまま ledger に書かれそうになったら、
  ledger に書く代わりに stderr に警告を出す防御を入れる（同じバグの再発を検知できるように）

## 作業2 `delegate-implementation` を重複検出器として整理する

recall 20% の弱い検出器を作り込むのではなく、**既存の実績ある仕組みに委ねる**。

`tools/cost-work-loop.mjs` が既に委譲率を行ベースで実測し、
`~/.claude/cost-enforce.json` を書いて `pretooluse-delegation-warn.mjs` /
`pretooluse-bash-delegation.mjs` が block している（今日、実際に2回ブロックされた実績あり）。
ここに2つ目の弱い検出器を並べるのは有害（数字が2種類出て、どちらを信じるか分からなくなる）。

`rules-registry.json` の `delegate-implementation` を次のように変える:
```jsonc
{
  "id": "delegate-implementation",
  "source": "ONBOARDING §1.18",
  "summary": "大きな実装は委譲する",
  "owner": "cost-work-loop.mjs",        // ← 検出と強制の責任はこちらにある
  "detect": { "mode": "delegated" },     // このループでは検出しない
  "enforcement": "off",
  "note": "委譲率の実測と強制は cost-work-loop.mjs が担当（~/.claude/cost-enforce.json）。二重計測を避けるためこのループでは検出しない。"
}
```
`rule-compliance-loop.mjs` は `detect.mode === "delegated"` のルールを
**レポートに「担当: cost-work-loop.mjs」と1行出すだけ**にして、違反カウントも昇格判定もしない。
テスト（8 登録簿の必須フィールド）を `delegated` モードに対応させる。

## 作業3 `tools/install-handoff-gate.mjs` を作る

`PROMPT-install-handoff-gate.md` に仕様が書いてあるので、それを読んで実装する。
要点だけ再掲:
- `~/.claude/settings.json` の Stop hook から `manual-handoff-detector.ps1` を外し、
  `handoff-quality-gate.mjs` を追加。SessionStart に `rule-compliance-report.mjs` を追加
- 旧 hook は `.bak-20260828-superseded` にリネーム（**削除しない**）
- **`--apply` を付けないと1バイトも書かない**（既定は dry-run）
- 編集前バックアップ + read-back検査（JSON.parse通る / 旧hook消えた / 新2件ある /
  **hook総数が「元 − 削除 + 追加」と一致**）。1つでも外れたらバックアップから復元して非0終了
- 冪等（2回目は「変更なし」）
- リポジトリのパスは `fileURLToPath(import.meta.url)` から解決（ハードコードしない）
- テストは `--home` で偽ホーム（`os.tmpdir()` 配下）を使い、**本物の settings.json を絶対に触らない**

**このタスクでは `--apply` を実行しない。** dry-run の出力を報告するだけ。

## 触らないこと
- `~/.claude` 配下（settings.json / CLAUDE.md / hooks）は書き換えない
- `~/.claude/rule-enforcement.json` を書かない
- 17:49 以前に更新されている他ファイル（`line-digest.mjs` / `auto-session.mjs` /
  `feedback-widget/*` / `.github/workflows/test.yml` 等）は別作業の未コミット変更。絶対に触らない
- `plan.mjs` 等 `sms-kanri-2026/` 配下は別リポジトリ。触らない

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が **全部green**（13件以上、fail 0）
2. `node tools/rule-detector-precision.mjs` の表
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` の出力
   （`delegate-implementation` が「担当: cost-work-loop.mjs」になっていること）
4. `node tools/install-handoff-gate.mjs`（--apply なし）の dry-run 出力と、
   **実際の `~/.claude/settings.json` のハッシュが実行前後で変わっていないこと**
