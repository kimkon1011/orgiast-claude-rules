# GoogleのURLの渡し方（AI共通ノウハウ）

> **このドキュメントの使い方（AIへ）**: Google Workspace（スプレッドシート・ドキュメント・スライド等）のURLをユーザーや他の人に共有するときのルールです。

## 絶対ルール

**Google WorkspaceのURLを送るときは、必ず `?authuser=<開く人のメール>` を付けてください。**

付けないと、ブラウザの既定のアカウント（多くの人は個人のGmailアカウント）で開こうとして「ファイルが見つかりません」と表示されます。

## サービス別URL形式

| サービス | URLの形 |
|---|---|
| スプレッドシート | `https://docs.google.com/spreadsheets/d/{ID}/edit?authuser=kim@orgiast.jp` |
| ドキュメント | `https://docs.google.com/document/d/{ID}/edit?authuser=kim@orgiast.jp` |
| スライド | `https://docs.google.com/presentation/d/{ID}/edit?authuser=kim@orgiast.jp` |
| フォーム | `https://docs.google.com/forms/d/{ID}/edit?authuser=kim@orgiast.jp` |
| Apps Script | `https://script.google.com/d/{ID}/edit?authuser=kim@orgiast.jp` |
| Drive ファイル | `https://drive.google.com/file/d/{ID}/view?authuser=kim@orgiast.jp` |
| Drive フォルダ | `https://drive.google.com/drive/folders/{ID}?authuser=kim@orgiast.jp` |

例外: `script.google.com/home/usersettings` 等の `/home/...` 系は authuser 不要（右上のアバターでアカウント切替を案内する）

## 注意点

| 項目 | 内容 |
|---|---|
| 生URL禁止 | URLをそのまま貼らず、必ず開くアカウント名を併記する（「kim@orgiast.jp で開いてください」） |
| authuser≠権限 | authuser パラメータは権限付与ではない。事前に対象アカウントにファイルを共有しておく必要がある |
| 他メンバー宛 | 先にファイルを共有し、`?authuser=<相手のメール>` を付けて「<メール> で開いてください」と併記する |
| フラグメント注意 | `#gid=` 等のフラグメントより前に `?authuser=` を置く |

## リンクの書き方

```
[資料のタイトル](https://docs.google.com/spreadsheets/d/xxxxx/edit?authuser=kim@orgiast.jp)
（kim@orgiast.jp で開いてください）
```