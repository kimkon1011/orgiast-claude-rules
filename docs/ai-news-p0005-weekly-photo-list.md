# P-0005 週次写真リスト自動送信 GAS 設計書

**ステータス**: 実装完了（PR #????）
**作成日**: 2026-11-15

## 概要

Google Apps Script で毎週月曜朝に指定フォルダの写真リストを自動配信し、スタッフの手動指示作業を削減する。

## アーキテクチャ

```
Drive フォルダ（写真格納）
    │
    ▼
weeklyPhotoListSend() ← 毎週月曜 08:00（時間トリガー）
    │
    ▼
buildPhotoList() → 画像ファイル一覧（更新日降順）
    │
    ▼
MailApp.sendEmail() → HTML テーブル形式で配信
```

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `Setup.gs` | `setupOnce()` — 初回セットアップ、Script Properties 初期化、CommandQueue インストール |
| `CommandQueue.gs` | コマンドキュー方式のインフラ + 設定コマンド群 |
| `WeeklyPhotoList.gs` | 写真リスト生成・メール送信のメインロジック |
| `appsscript.json` | OAuth スコープ、ランタイム設定 |
| `.clasp.json` | clasp 設定（scriptId は初回 push 後に設定） |

## 設定項目（Script Properties）

| キー | 説明 | 既定値 | 設定方法 |
|------|------|--------|---------|
| `PHOTO_FOLDER_ID` | 監視対象 Drive フォルダ ID | 空 | `setPhotoFolder` コマンド |
| `RECIPIENT_EMAILS` | 送信先メールアドレス（カンマ区切り） | 空 | `setRecipients` コマンド |
| `SEND_TIME` | 送信時刻（HH:mm） | `08:00` | `setSendTime` コマンド |

## コマンド一覧（CommandQueue）

| コマンド | 引数 | 説明 |
|---------|------|------|
| `setPhotoFolder` | `{folderId: string}` | 監視フォルダ ID を設定（存在確認あり） |
| `setRecipients` | `{emails: string}` | 送信先メール（カンマ区切り、形式検証あり） |
| `setSendTime` | `{time: string}` | 送信時刻を変更 |
| `describeConfig` | なし | 現在の設定を取得（フォルダ名含む） |
| `sendNow` | なし | 即座にテスト送信を実行 |
| `installWeeklyTrigger` | なし | 毎週月曜のトリガーを設置 |
| `uninstallTriggers` | なし | 全トリガーを削除 |

## メール内容

- **件名**: `【自動配信】週次写真リスト YYYY/MM/DD（N件）`
- **本文**: HTML テーブル形式
  - フォルダ名 + リンク
  - 生成日時
  - ファイル一覧（ファイル名・更新日・サイズ・種類・リンク）
  - 更新日降順ソート

## セットアップ手順（kim 操作）

1. `clasp create --type sheets --title "週次写真リスト自動配信"`
2. `.clasp.json` の `scriptId` を更新
3. `clasp push -f` でデプロイ
4. GAS エディタで `setupOnce()` を ▶実行
5. Claude Code から CommandQueue 経由で設定:
   - `setPhotoFolder` → 写真フォルダ ID
   - `setRecipients` → 配信先メールアドレス
   - `installWeeklyTrigger` → 月曜朝の定期実行を有効化
6. `sendNow` でテスト送信し、受信確認

## 制約・注意点

- MailApp の送信上限: 1日あたり 100 受信者（無料アカウント）
- サブフォルダは再帰しない（フラットなフォルダ構造を前提）
- 対応画像形式: JPEG, PNG, GIF, WebP, BMP, SVG, HEIC, HEIF
- ファイル数が多くても 1 通のメールに全件含める（分割なし）
- 写真が 0 件の場合も「0件」メールを送信（フォルダ空の検出用）