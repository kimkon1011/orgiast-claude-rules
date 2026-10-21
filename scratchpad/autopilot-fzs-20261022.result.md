# feedback-zero-sweep 調査結果（2026-10-22）

## 真因

夜間ログの末尾 queued=0/deferred=0 は最後のアプリ行であり、巡回全体の健全性を表さない。2026-10-21 のログは25行目が04:05:42の失敗、42行目が05:04:44の全体サマリ。notification.delivered=dm のJSON出力後にexit 1なので、当時の終了判定は unknown > 0。どのアプリのどのエラーだったかは、末尾8行しか保存されておらず断定できない。

現在の tools/feedback-zero-sweep.mjs:194 で statusが取得済でない行またはerrorsがある行をunknownに集計し、:207 の unknown > 0 が1を返し、:228 でprocess.exitCodeへ代入する。

終了1への全経路:
- :207 unknown > 0。内訳は intake取得上限によるpartial (:136)、refs欠落・API/JSON/原票の契約違反・正規化失敗等のアプリ内例外 (:185)、Issue照合失敗 (:157)、Issue完了でも原票更新待ち (:154)、repo未設定 (:162/:164)、Issue化失敗 (:165)、完了通知例外 (:189)、投稿者DM未達 (:192)。
- :211 通常実行でdeliveredがdmでなく、残件あり／none以外／reasonあり。健全な空sweepのnone（reasonなし）は成功。dry-runはこの判定をスキップ。
- :229 最上位catch。不正引数 (:225)、registry不正、lock競合、台帳読込・保存エラー、通知処理の未捕捉例外、lock解放エラー等。JSONをパースして終了コードを決める処理はない。
- queued/deferred単独では終了コードを決めない。実装失敗等のdeferred化も、それ自体はunknownに積まれない。

最初に指定のgit logを確認した。#949 dfa8463は2026-10-22 00:17:01 +0900、#954 b1f1949は2026-10-21 16:01:55 +0000（日本時間10-22 01:01:55）。いずれも10-21の失敗後であり、既に直っている可能性がある。現行実データdry-runはexit 0だった。

再現できた機序は、原票が空でも台帳の既存Issueを照合するため、一時的なgh失敗がunknownへ積まれること。#954前では一度の失敗で :157 相当へ入り、queued=deferred=0、unknown=1、exit 1。現行の :95〜109 の再試行でCLOSEDを取得できれば、remaining=unknown=0、exit 0。本番の10-21の個別エラーがこれだったとまでは証明できない。

## 再現出力（exit code と JSON 要約）

実データ読取りのみ。WSLのHOME違いで設定欠落を作らないようORGIAST_HOMEをWindowsユーザーに指定。既存 --dry-run によりIssue作成・実装・状態保存・完了通知・DMを抑止。

```sh
ORGIAST_HOME=/mnt/c/Users/uers node tools/feedback-zero-sweep.mjs --dry-run
```

exit code: 0。remaining=12、unknown=0、launched=0。stderr空。完全なstdout:

```json
{
  "dryRun": true,
  "remaining": 12,
  "unknown": 0,
  "launched": 0,
  "rows": [
    {
      "appName": "購買部管理アプリ",
      "remaining": 6,
      "status": "取得済",
      "errors": [],
      "queued": 6,
      "deferred": 0
    },
    {
      "appName": "カフェ業務チェック",
      "remaining": 0,
      "status": "取得済",
      "errors": [],
      "queued": 0,
      "deferred": 0
    },
    {
      "appName": "イベントショップ",
      "remaining": 0,
      "status": "取得済",
      "errors": [],
      "queued": 0,
      "deferred": 0
    },
    {
      "appName": "ブース制作アプリ",
      "remaining": 2,
      "status": "取得済",
      "errors": [],
      "queued": 0,
      "deferred": 0
    },
    {
      "appName": "aujust／営業自動化",
      "remaining": 3,
      "status": "取得済",
      "errors": [],
      "queued": 3,
      "deferred": 0
    },
    {
      "appName": "倉庫アプリ",
      "remaining": 1,
      "status": "取得済",
      "errors": [],
      "queued": 1,
      "deferred": 0
    },
    {
      "appName": "学会制作最終チェック",
      "remaining": 0,
      "status": "取得済",
      "errors": [],
      "queued": 0,
      "deferred": 0
    }
  ],
  "notification": {
    "delivered": "none"
  }
}
```

決定的なローカル再現: 空のrelay原票、台帳にCLOSEDのIssue、ghは1回目status=1・2回目CLOSED。ネットワーク・DMなし。実行スクリプトは `.scratch/fzs-20261022/reproduce.mjs`。

#954前（dfa8463）のモジュールで実行、exit code: 1:

```json
{
  "dryRun": true,
  "remaining": 1,
  "unknown": 1,
  "launched": 0,
  "rows": [
    {
      "appName": "fixture",
      "remaining": 1,
      "status": "未取得（Issue照合失敗）",
      "errors": [
        "Issue状態 未取得"
      ],
      "queued": 0,
      "deferred": 0
    }
  ],
  "notification": {
    "delivered": "none"
  }
}
```

現行モジュールで同じ入力、exit code: 0:

```json
{
  "dryRun": true,
  "remaining": 0,
  "unknown": 0,
  "launched": 0,
  "rows": [
    {
      "appName": "fixture",
      "remaining": 0,
      "status": "取得済",
      "errors": [],
      "queued": 0,
      "deferred": 0
    }
  ],
  "notification": {
    "delivered": "none"
  }
}
```

## 変更点

既存の #913/#914/#949/#954 を重複実装せず、本体変更なし。tools/feedback-zero-sweep.test.mjs に3テスト追加。
- 空の原票＋台帳照合の一時失敗から回復すると、通常/dry-runともunknown=0、queued=deferred=0、通知なし、exit 0。
- Issue照合が3回失敗した場合はqueued=deferred=0でもexit 1。
- HTTP 403は通常/dry-runともexit 1。
既存の必須refs欠落テストも維持。

## テスト結果（コマンドと pass/fail 数）

ベースライン `node --test tools/feedback-zero-sweep.test.mjs`: pass 18 / fail 0。
追加後、ローカルクローンで同コマンド: pass 21 / fail 0、exit 0。

`node --test --test-name-pattern=空の原票でも台帳 tools/feedback-zero-sweep.test.mjs` を #954前のモジュールで実行: pass 0 / fail 1。sweepExitCodeの期待0に対し実際1で失敗。旧モジュールの非公開issueStateをexportへ変更して現在のテストimportと互換にしたのみで、旧ロジックは変更していない。検証後は現行モジュールへ復元済み。
証跡: `.scratch/fzs-20261022/red-tests.log`、`green-tests.log`、`before.json`、`before.exit`。
`git diff --check -- tools/feedback-zero-sweep.test.mjs`: 成功。

## ブランチ名とコミット hash

ブランチ: `fix/feedback-zero-sweep-exit1-20261022`
コミット: `c4e2b7f289c2bdc8c9c8e00865552930e29e3240`
ベース: `68180ed2786ff6b71093188f606ff111aabed124`
作成先: `/mnt/c/Users/uers/.claude/nightly-repo/.wt/feedback-zero-sweep-exit1-20261022`
元リポジトリの.gitがread-onlyでブランチ作成が拒否されたため、許可されたcwd配下の永続ローカルクローンに作成。push・PR・force操作なし。元cwdにも同一のテスト差分を残している。

監督の検証コマンドはクローンを対象にする:

```sh
git -C .wt/feedback-zero-sweep-exit1-20261022 diff 68180ed2786ff6b71093188f606ff111aabed124..fix/feedback-zero-sweep-exit1-20261022 --stat
cd .wt/feedback-zero-sweep-exit1-20261022
node --test tools/feedback-zero-sweep.test.mjs
```

## 未解決・注意

指定された `C:/Users/uers/.claude/scratchpad/autopilot-fzs-20261022.result.md` は書き込み許可範囲外。代替としてcwd配下 `scratchpad/autopilot-fzs-20261022.result.md` にUTF-8保存した。承諾待ちで停止せず許可範囲で完遂した。

過去の原因分岐unknown>0は特定したが、その元となった個別エラーはログ不足で未確定。本番の再発がなくなったとは断定しない。現在の実データは空ではなく残件12で、dry-runではIssue作成・完了通知を検証しない。次回夜間実行は #949 で追加済みのunknown_rows行を確認する。

現在の終了コードロジックに未修正の不具合は再現していないため、実エラーを握り潰す変更は行わなかった。回帰テストの「修正前」は今回開始時のHEADではなく既存 #954 の導入前を指す。

ローカルクローンは --shared のため元リポジトリのオブジェクトに依存する。移送用パッチを `.scratch/fzs-20261022/commit.patch` に保存。
