# 本番 UI の動作確認を Claude 側でどこまでやれるか（実測）

handoff-audit: `408e4194471c4ab7` / 実測日: 2026-09-21〜22

## 元の手渡し（何が問題だったか）

2026-09-18 セッション `dd676e9e` の締め（handoff-audit 判定 = **block** / rule 1・rule 6）:

> 次に kim がすること: 1件 — https://aujust-sales-automation.vercel.app の Reブース案件を1件開いて、
> 実際の運用に合っているか見てください（列マッピングの追加要望があれば直します）

監査の fix は「Bash(curl/Playwright) でヘッダー直下の行挿入と登録済み表示を Claude 側で確認し、
実測スクショを提示する」だった。**その fix が実際に成立するかを実測したのが本ドキュメント。**

データ側（Sheets 読み戻し）は別監査 `14f2bd38e35a58ce` で実証済み → [`sheets-write-verification.md`](./sheets-write-verification.md)。
本ドキュメントは**UI 側**の到達可能性だけを扱う。

## 実測結果 1: 本番 UI は Claude 側で描画できる（ログイン不要な層）

`playwright-core` + ローカルの Chromium で実描画。**ログイン試行・書き込み・送信はゼロ**。

| 項目 | 実測値 |
|---|---|
| 実行 | `node runs/2026-09-22-7-prod-ui-probe.mjs`（headless / viewport 1280x900 / ja-JP） |
| ブラウザ | `%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe` |
| 遷移 | `307 /` → `200 /login` |
| title | `オージャスト営業自動化` |
| 描画された本文 | 「登録済みのメールアドレスを入力すると、ログイン用のリンクが届きます。」 |
| 操作要素 | `form` 1 / `input[type=email]` 1 / ボタン2（`ログインリンクを送信` / `@orgiast.jp は Google でログイン`） |
| スクショ | `runs/2026-09-22-7-prod-ui-login.png` **37,818 B**（実ファイル確認済み） |

→ **「画面を開いて目視」のうち、到達性・描画・文言の確認は kim に渡さず Claude で完結する。**

## 実測結果 2: 業務画面は全ルートがログイン必須

`curl` で直接叩いた結果（すべて `307`）:

| パス | 応答 |
|---|---|
| `/` `/cases` `/dashboard` `/deals` `/api/cases` `/api/deals` `/settings` | すべて `307 → /login` |

認証は **①メールのログインリンク（magic link）** と **②@orgiast.jp の Google OAuth** の2経路のみ。

## 境界（正直に書く）: 認証後画面の描画は **未確認**

無人会話では次のどちらの経路も踏めない。

- ① magic link: リンクを出すには `kim@orgiast.jp` 宛に**メールを送る**必要がある（外部送信＝本セッションの禁止事項）
- ② Google OAuth: 対話同意が必須（人間の権限が必要な4種のうち「ログイン」）

**したがって「認証後の案件詳細画面のスクショを Claude が撮る」は、現構成では無人会話の範囲外。**
ここで「Playwright で全部できる」と書くと、監査の fix を過大評価することになる。実際は**到達できるのは login 層まで**。

## それでも手渡しが不要な理由（論点の置き換え）

元の依頼の論点は「**実際の運用に合っているか**」＝列マッピングが実務の列に正しく入っているか。
これは UI の見た目ではなく**データの正しさ**であり、Sheets API の読み戻しで判定できる（`14f2bd38e35a58ce` で実証済み:
ヘッダー名解決でデザイナー様用 idx3 / ディレクター様用 idx5 に正しく格納、投入行はヘッダー直下 3 行目に実在）。

**UI の目視でしか分からない論点（描画崩れ等）が出た時だけ**、認証済みセッションが要る。
その時も kim にスクショを頼むのではなく、**アプリ側の e2e 用 auth state（storageState）を保存して Playwright に食わせる**のが正規の経路。

## 使う順序（推奨ルート）

1. `curl` 1 本で `307 → /login` を確認（到達性・認証要否はこれで確定する。**目視不要**）
2. 論点がデータ正しさなら **Sheets/DWD の読み戻し**で判定（[`sheets-write-verification.md`](./sheets-write-verification.md)）
3. 論点が描画そのものなら **Playwright + `storageState`**（auth state はアプリの e2e セットアップで作る）
4. 上のどれでも取れない時だけ「未確認」と書き、kim に**目視を依頼しない**（未確認は未確認として記録する）

## 落とし穴（次のセッションが同じ所で転ぶ）

- `playwright-core` はこの PC では `~/.claude/tools/node_modules/playwright-core` に入っている（リポジトリの node_modules には無い）
- Windows の絶対パスは **ESM の動的 import にそのまま渡せない**（`ERR_UNSUPPORTED_ESM_URL_SCHEME: c:`）。
  `pathToFileURL(...).href` に変換する
- `playwright-core` は CJS。`await import()` の名前空間に `chromium` が生えず `default.chromium` になる場合がある（両対応にする）
- Chromium の実体は `chromium-*/chrome-win64/chrome.exe`（`chrome-win` ではない版がある）。`executablePath` を明示する

## 再現スクリプト

- `~/.claude/auto-session/runs/2026-09-22-7-prod-ui-probe.mjs` — 1 コマンドで遷移・本文・操作要素・スクショを取得
- 出力例: `runs/2026-09-22-7-prod-ui-login.png`
