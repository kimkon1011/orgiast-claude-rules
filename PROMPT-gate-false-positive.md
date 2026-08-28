# gate の誤検知を直す — 廃止タグに「言及しただけ」で block される

## 実際に起きたこと（実測）
手作業依頼を1つも含まない応答が `handoff-quality-gate.mjs` に block された。
block理由: `このタグは廃止。[手渡し判定] を書いてください。`

その応答は、廃止された通行証タグ（`HANDOFF` + `-OK` を角括弧で囲んだもの）を
**「廃止した」と説明していただけ**で、使ってはいなかった。
PR本文や設計説明でこのタグ名に触れると必ず止まる状態になっている。

## 原因
`tools/handoff-quality-gate.mjs` の `evaluateHandoff()`:
```js
export function evaluateHandoff(text, { catalog, enforcement = {} } = {}) {
  if (/\[HANDOFF-OK\]/.test(text)) return { decision: 'block', reason: 'このタグは廃止。…' };
  if (!hasHandoff(text)) return { decision: 'pass', reason: '手渡しなし', routesMatched: [] };
  ...
```
**廃止タグの検査が `hasHandoff()` より前にある。**
そのため「手渡しが存在しない応答」でも、タグ名が本文に現れただけで block になる。
タグを *使った* ことと、タグに *言及した* ことを区別していない。

## 修正

### 1. 判定順序を入れ替える
廃止タグの検査を `hasHandoff()` の **後** に移す。
手渡し語彙が検出されていない応答は、タグ名が出てきても素通しする。

### 2. 「言及」を除外する
順序を変えても「手渡しあり + タグに言及」でまだ誤検知するので、
次のいずれかに該当する出現は **使用ではなく言及** とみなして無視する:
- バックティック（`` ` ``）で囲まれている
- 三連バックティックのコードブロック（``` ``` ```）の内側にある
- 同じ行、または前後1行以内に「廃止」「deprecated」「禁止」「使わない」「置き換え」のいずれかがある
- 引用行（行頭が `>` ）にある

実装は「タグの全出現位置を列挙し、上記に該当しない出現が1つ以上あるときだけ block」とする。
コードブロックの内外判定は三連バックティックの出現数で行う（奇数番目の区間が内側）。

### 3. 同じ問題が他の検査にもないか点検する
`handoff-quality-gate.mjs` の他の正規表現（`handoffPatterns` / 効率語彙 /
`automation-routes.json` の経路名マッチ）についても、
**「引用・コードブロック内の文字列を実際の使用と誤認する」経路がないか**確認して報告する。
特に、gate や ルール自体を説明する応答（今日のようなメタな作業）で誤検知しないこと。

## 回帰テスト（`tools/handoff-quality-gate.test.mjs` に追加）
1. **手渡しゼロ + 廃止タグに言及**（「このタグは廃止した」と説明する文）→ **pass**
2. 手渡しあり + 廃止タグをバックティックで囲んで言及 + 正しい `[手渡し判定]` ブロック → **pass**
3. 手渡しあり + 廃止タグを**素で使用**（前後に廃止語彙なし・引用でもコードブロックでもない）→ **block**
4. 手渡しあり + コードブロック内にタグ + 正しい `[手渡し判定]` ブロック → **pass**
5. 既存22テストが全部通り続ける（特に「1 旧gateをすり抜けた実物をblock」と
   「7 過去形の完了報告はpass」）

## 厳守
- **既存の block 判定を弱めない。** 誤検知を消すのが目的で、
  本物の手渡し（品質理由なし / 経路3件未満 / 却下経路なし）は今まで通り block すること
- `~/.claude` 配下（settings.json / CLAUDE.md / hooks）は書き換えない
- `~/.claude/rule-enforcement.json` を書かない
- `install-handoff-gate.mjs` を `--apply` で実行しない
- 他ファイル（`line-digest.mjs` / `auto-session.mjs` / `booth-feedback-intake.mjs` /
  `nightly-batch.ps1` / `feedback-widget/*` / `.github/workflows/*` 等）は
  別作業の未コミット変更。**絶対に触らない**
- `sms-kanri-2026/` 配下は別リポジトリ。触らない
- Windows / ESM(.mjs) / UTF-8 BOMなし。テストで `new URL(...).pathname` を使わない
  （Windowsで `/C:/...` になる。`fileURLToPath` を使う）

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が全部green（26件以上、fail 0）
2. 上記回帰テスト1の文面を実際に stdin で gate に流して `decision` が返らない（pass）ことを、
   コマンド出力を貼って示す
3. 上記回帰テスト3の文面を流して `decision: block` が返ることを、コマンド出力を貼って示す
