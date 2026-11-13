@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
REM ============================================================
REM M&Aナビ 売り手新規登録（1クリック）
REM ブラウザが開くので、以下の手順で登録してください:
REM   1. 利用者属性: 「法人」を選択
REM   2. メールアドレス: seisaku-team@orgiast.jp
REM   3. 「登録」ボタンをクリック
REM   4. 届いた確認メールのリンクから本登録
REM   5. パスワード: Partner123（新規サイト共通）
REM ============================================================
start https://ma-navigator.com/seller/sign_up
echo.
echo ============================================================
echo M&Aナビ 売り手登録ページを開きました
echo.
echo 【登録手順】
echo 1. 利用者属性: 「法人」を選択
echo 2. メール: seisaku-team@orgiast.jp
echo 3. 「登録」をクリック
echo 4. seisaku-team@orgiast.jp に届く確認メールから本登録
echo 5. パスワード: Partner123
echo.
echo 【登録後に必要な作業】
echo 1. M&Aナビにログイン
echo 2. 案件情報を入力（NF民泊の内容）
echo    - 業種: 簡易宿泊施設・民泊
echo    - 希望価格: 800万円
echo    - 大阪市・特区民泊認定2物件
echo 3. 公開申請
echo ============================================================
echo.
echo Press any key to close.
pause >nul
