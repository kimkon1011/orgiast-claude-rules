# タスク: ブース制作アプリの「不具合要望」を毎日自動で拾って作業キューへ積む

## 背景
ブース制作アプリ（GAS）の報告ダイアログから社員が投げた不具合・要望は
master スプレッドシート「不具合要望」シートに溜まる。
**それを定期的に拾う仕組みが1つも無い**ため、kim が気付いて口頭で伝えるまで着手されない（実害発生中）。

そこで、このPCの日次ジョブが GAS の WebApp API から「未対応の要望」を取得し、
**`~/.claude/next-session.md` の「## 残TODO」に積む**。
夜間の無人セッション（OrgiastAutoSession, 03:20）は next-session.md の残TODO を読むので、
これで「溜まる → 気付かれる → 作業キューに入る」までが自動化される。

## 対象リポジトリ
`C:\Users\uers\Downloads\orgiast-claude-rules`（WSL からは `/mnt/c/Users/uers/Downloads/orgiast-claude-rules`）

## 依存する API（別タスクで GAS 側に実装済みの前提で書いてよい。**このタスクでは GAS を触らない**）

`GET <BOOTH_FEEDBACK_URL>?token=<TOKEN>&action=feedback`

```json
{
  "ok": true,
  "sheetUrl": "https://docs.google.com/a/orgiast.jp/spreadsheets/d/…/edit",
  "counts": { "open": 1, "total": 3 },
  "items": [
    { "key": "fb-1787887803441-eykir8lm", "rowNumber": 4, "ts": "2026-08-28 12:30",
      "kind": "要望", "title": "アサイン依頼の文章", "body": "…", "status": "new",
      "note": "", "source": "ダイアログ(…)", "images": ["https://…"] }
  ]
}
```

`POST <BOOTH_FEEDBACK_URL>` body `{"token":"…","action":"resolveFeedback","key":"…","status":"done","note":"…"}`
→ `{"ok":true,"rowNumber":4,"previousStatus":"new"}`

## 実装するもの

### 1. `tools/booth-feedback-intake.mjs`（新規）

**既存の `tools/*.mjs` の書き方に合わせること**（ESM / `import { isEntry } from './is-entry.mjs'` /
`parseEnvText` を `./env-kv.mjs` から / 純関数を export してテストしやすくする / `--dry-run` を持つ）。
`tools/auto-session.mjs` と `tools/fleet-sheet-report.mjs` が最も近い参考実装。

**設定の読み先**: `~/.claude/booth-feedback.env`（`ORGIAST_HOME` があればそれを home として使う）
```
BOOTH_FEEDBACK_URL=https://script.google.com/macros/s/…/exec
BOOTH_FEEDBACK_TOKEN=…
```
- 未設定なら **stderr に理由を出して exit 0**（cron を赤くしない。fleet-sheet-report.mjs と同じ方針）。

**台帳**: `~/.claude/booth-feedback-ledger.json`
```json
{ "version": 1, "items": { "<key>": { "firstSeen": "2026-08-28T03:00:00.000Z",
    "injectedAt": "2026-08-28T03:00:00.000Z", "title": "…", "lastStatus": "new" } } }
```
- 壊れた JSON / 無いファイルは `{version:1, items:{}}` として扱う（例外を投げない）。

**既定動作（引数なし）**:
1. API から open な items を取得
2. **台帳に `injectedAt` が無い key だけ**を「新着」とする
3. 新着を `~/.claude/next-session.md` の「## 残TODO」に**追記**する
4. 台帳を更新（`firstSeen` / `injectedAt` / `title` / `lastStatus`）
5. 標準出力に1行サマリ: `booth-feedback: open=3 new=1 injected=1 (skipped: already-injected 2)`

**next-session.md への追記仕様（重要）**:
- `<!-- NEXT-SESSION v1 -->` の **最初のブロック**を対象にする（`tools/auto-session.mjs` の `firstBlockBounds` / `sectionFrom` と**同じ解釈**にすること。可能ならその関数を import して再利用する）。
- `## 残TODO` セクションの **末尾**に、既存の番号付きリストの続き番号で追記する。
  （末尾の番号を検出して +1。セクションが無ければブロック末尾に `## 残TODO（自動取込）` を作ってから `1.` で始める）
- 1件あたりの書式（**1行目のみ必須、2行目以降は任意**）:
  ```
  N. **[FB:<key>] <title>**（ブース制作アプリ 不具合要望 / <ts> / <source>）— <body の先頭100字を1行化>。**着手可否は kim 判断待ち**。シート: <sheetUrl>
  ```
- **`着手可否は kim 判断待ち` の文字列を必ず含めること**。
  `tools/auto-session.mjs` の `todoExclusionReason()` は `判断待ち` を含む TODO を除外するので、
  **無人セッションが勝手に本番コードを書き換えるのを防ぐゲート**になる。この文言を削ってはいけない。
- **冪等**: `next-session.md` の本文に既に `[FB:<key>]` が出現していたら、台帳に無くても追記しない（台帳を消しても二重に増えない）。
- 書き込みは **read → 変更 → write の1回**。既存の他セクションの文字列を1バイトも変えないこと
  （テストで「残TODO 以外の部分が変更前と完全一致」を assert する）。

**サブコマンド**:
- `--dry-run` … 追記も台帳更新もせず、何をするかを標準出力に出す（差分プレビュー）
- `--list` … open な items を人が読める形で一覧表示するだけ（副作用なし）
- `--resolve <key> --note "<text>"` … POST で状態を done にする。`--status <s>` で done 以外も指定可。
  成功したら台帳の該当 key に `resolvedAt` を入れる。
- `--json` … 機械可読出力（Claude セッションから使う）

**ネットワーク**:
- `fetch` に **20秒のタイムアウト**（`AbortController`）。失敗時は stderr に1行出して **exit 0**（cron を赤くしない）。
  ただし `--resolve` の失敗だけは **exit 1**（人が結果を知りたい操作なので）。
- GAS WebApp は 302 を返すので **リダイレクトを追う**こと（`fetch` の既定で追われる。`redirect:'follow'` を明示）。
- 応答が JSON でない（HTML のログイン画面が返る等）場合は、本文の先頭200字を stderr に出す。

### 2. テスト `tools/booth-feedback-intake.test.mjs`（新規）

`node --test` で回る。**ネットワークとファイルシステムは注入**して実 I/O をしない
（既存 `tools/auto-session.test.mjs` / `tools/fleet-sheet-report` 系のテストの流儀に合わせる）。

最低限これを assert:
1. 新着1件が `## 残TODO` の末尾に、**続き番号**で追記される
2. 追記された行に `[FB:<key>]` と `着手可否は kim 判断待ち` が含まれる
3. **同じ入力で2回流しても増えない**（台帳あり／台帳を消しても本文に `[FB:key]` があれば増えない、の2ケース）
4. **残TODO 以外のバイト列が変更前と完全一致**（`## 次の1目的` 等を壊さない）
5. `## 残TODO` が無い next-session.md でも落ちずにセクションを作る
6. API が `{ok:false}` / タイムアウト / HTML を返したとき、**next-session.md を書き換えず exit 0**
7. 追記した TODO が `auto-session.mjs` の `todoExclusionReason()` で**除外される**こと
   （実際に `todoExclusionReason` を import して assert する。これが安全ゲートの回帰テスト）

`node --test tools/booth-feedback-intake.test.mjs` が green、
かつ既存テスト（`node --test tools/*.test.mjs` のうち元から green のもの）を壊さないこと。

## やらないこと
- GAS 側のコード（別タスク）
- Discord 通知（GAS 側に既存の通知経路がある。二重通知はノイズなので**このツールからは送らない**）
- スケジュールタスクの登録（**監督が行う**）
- 実際に本番の next-session.md を書き換えること（テストは一時ディレクトリで行う）

## 完了条件
1. `node --test tools/booth-feedback-intake.test.mjs` が green
2. `node tools/booth-feedback-intake.mjs --dry-run` が、env 未設定の環境でも例外を投げず exit 0
3. 追記文言が `todoExclusionReason()` に確実に引っかかることをテストで示せている
