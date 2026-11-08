# ラハイナ Instagram トークン登録 .cmd（このPC用）

作成: 2026-10-14 自動セッション / 出典: nishi向け引継書「ラハイナInstagram 引継書 2026-10-08」
（Drive fileId `1MFhHrYnVjUoVEj_3aP2uQ5xBBzRQ4ELHqpVyTaYjgms`、全文は `~/.claude/auto-session/runs/nishi-instagram-handoff.md`）

## 何を作ったか

Meta「Instagram API with Instagram Login」の長期アクセストークン（60日）を、
kim が **1回だけ** 発行してこのPCに登録するための、ダブルクリック用 `.cmd`。

- デスクトップ: `ラハイナInstagramトークン登録（ダブルクリック）.cmd`（ASCII・CRLF・BOMなし、2,461B）
- 登録先: `C:\Users\kimko\lahaina-instagram\.env` の `INSTAGRAM_ACCESS_TOKEN=`
- 日本語の詳細手順: `C:\Users\kimko\lahaina-instagram\SETUP-ja.txt`（.cmd が自動で Notepad で開く）

## 置き場を共有リポジトリにしなかった理由

引継書 §4 は「引継ぎ先リポジトリの .env」とするが、このPCの唯一のリポジトリは
`orgiast-claude-rules`（GitHub へ push され全PCへ配布される共有ルールリポジトリ）。
引継書 §7 が記録するとおり、引継ぎ元PCでは `.env` が gitignore されず **トークンが漏れていた**。
同じ事故を避けるため、トークンは Git 管理外・OneDrive 同期外のローカル専用フォルダに置く。
（同リポジトリには `docs/lahaina-*.md` があるので、**この文書だけ**はルールリポジトリに残してよい。トークンは残さない。）

## 実装（.cmd 全文・ASCII のみ）

```bat
@echo off
setlocal EnableExtensions
rem ============================================================
rem  Lahaina Instagram - one-time Meta token registration.
rem  ASCII only on purpose: a .cmd with non-ASCII bytes breaks
rem  under CP932 and does nothing when double-clicked.
rem  Japanese guide (opened below): %DIR%\SETUP-ja.txt
rem ============================================================

set "DIR=C:\Users\kimko\lahaina-instagram"
set "ENV=%DIR%\.env"
set "TMP_ENV=%ENV%.tmp"

if not exist "%DIR%" mkdir "%DIR%"

title Lahaina Instagram - token registration
echo.
echo  ==========================================================
echo   Lahaina Instagram - token registration (one time only)
echo  ==========================================================
echo.
echo  A Japanese step-by-step guide is opening in Notepad.
echo  Follow it together with this window.
start "" notepad "%DIR%\SETUP-ja.txt"
echo.
echo  STEP 1  Opening the Meta App Dashboard in your browser...
start "" "https://developers.facebook.com/apps/"
echo.
echo    a) Log in with the NEW operator Facebook account
echo       (your own or the new company - NOT Sanyo Kankyo).
echo    b) Create app  -^>  type: Business  -^>  add product: Instagram
echo    c) Left menu:  Instagram ^> API setup with Instagram business login
echo    d) Click "Generate token", log in as lahaina_ushimado
echo       with the received ID/password, allow, then COPY the token.
echo.
echo  STEP 2  Paste the token below and press Enter.
echo          (nothing is shown while you paste - that is normal)
echo.
set "TOKEN="
set /p "TOKEN=> "
if not defined TOKEN (
  echo.
  echo  No token entered. Nothing was changed. Run this file again later.
  pause
  exit /b 1
)

echo.
echo  STEP 3  Saving to %ENV%
if exist "%ENV%" (
  findstr /v /b /c:"INSTAGRAM_ACCESS_TOKEN=" "%ENV%" > "%TMP_ENV%"
  move /y "%TMP_ENV%" "%ENV%" > nul
)
>> "%ENV%" echo INSTAGRAM_ACCESS_TOKEN=%TOKEN%
echo          saved.

echo.
echo  STEP 4  Verifying with the Meta Graph API ...
echo          SUCCESS looks like:  {"user_id":"...","username":"lahaina_ushimado"}
echo.
curl.exe -s "https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=%TOKEN%"
echo.
echo.
echo  If the line above contains "lahaina_ushimado"  -^>  DONE. Close this window.
echo  If it contains "error"  -^>  screenshot this window and send it to Claude.
echo.
pause
endlocal
```

## 検証（2026-10-14、このPCで実測）

| 項目 | 方法 | 結果 |
|---|---|---|
| バイト種別 | 全バイト走査 | 非ASCII 0 / CRLF 67 / 孤立LF 0 / BOMなし |
| 空入力 | サンドボックス複製（start行を除去）に空行を投入 | `.env` を作らず「No token entered」で exit 1 |
| 保存 | 同上に偽トークン投入 | `INSTAGRAM_ACCESS_TOKEN=FAKE_TOKEN_123` を正しく作成 |
| API疎通 | 同上が `curl.exe` を実行 | `graph.instagram.com/v21.0/me` が `code:190 Invalid OAuth access token` を返す＝経路は生きている |
| 再実行 | 2つ目の偽トークンで再投入 | キー行は常に1行（上書き）、`.tmp` は残らない |
| curl/cmd | `Get-Command` | `C:\WINDOWS\system32\curl.exe` / `cmd.exe` あり |

※ 検証は本物の `.cmd` を複製し、`start`（ブラウザ/Notepad 起動）行だけ外して実行した。本物の `.cmd` は未改変。
※ 実トークンでの `/me` が `lahaina_ushimado` を返すところは、人が Meta で発行する必要があり未検証。

## 残り

1. **kim の1アクション**: デスクトップの `.cmd` をダブルクリック → Meta でアプリ作成・トークン発行 → 貼り付け。
2. トークン受領後の実装（引継書 §5、別セッション）: `post.mjs`（コンテナ作成→publish）と `refresh-token.mjs`（毎日、残10日で更新）。メディア置き場（公開HTTPS）も決める。
3. 検証は API の成功応答だけでなく `https://www.instagram.com/lahaina_ushimado/` を開いて実表示を読み戻す。
4. この文書のコミットは push 不可のため未 push（資格情報のあるPCで PR 化）。
