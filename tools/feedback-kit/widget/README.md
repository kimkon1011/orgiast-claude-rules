# 全社標準 アプリ内フィードバック

オージャスト社内の Next.js アプリへ、不具合・要望フォーム、Discord 通知、管理キューを1コマンドで導入する標準パッケージです。追加 npm パッケージは不要です。

```sh
node tools/feedback-kit/install.mjs --app <対象アプリのパス> --name "<アプリ名>"
```

## 保存モード

| モード | 条件 | 保存先 |
|---|---|---|
| supabase | Supabase の URL・service role がある | DB（Discord 未設定なら通知を省略） |
| discord-only | Supabase が無い、またはテーブル未作成 | Discord のみ |
| both（既定） | Supabase と Discord の両方が利用可能 | DB + Discord |

ログイン不要の公開サイトにも設置できます（ハニーポット・IP レート制限・入力長上限が常時有効。詳細は [INSTALL.md](./INSTALL.md)）。

| 環境変数 | 用途 | 必須条件 |
|---|---|---|
| `FEEDBACK_OWNER_DISCORD_ID` | kim と併せて投稿通知を送る開発者の Discord user ID | 標準通知を使う全アプリで必須（17〜20桁） |

## 導入状況

| アプリ | 状況 |
|---|---|
| aujust-sales-automation | 手移植済み・本番稼働 |
| anniversary-mail | 手移植済み |
| assign-app | 本パッケージで導入予定 |

## 運用

社員がアプリ内から投稿 → 中継が kim + 開発者へ DM → 実装 → Issue closed（または手動完了通知）→ 夜間ジョブが投稿者へ完了 DM、という流れです。開発者IDは `FEEDBACK_OWNER_DISCORD_ID`（17〜20桁）で、標準通知を使う全アプリで必須です。導入後は `verify.mjs` で投稿と read-back を検証します。詳細は [INSTALL.md](./INSTALL.md) を参照してください。

## 送信内容・対応状況の閲覧（1.1.0以降の必須機能）

フォームの送信ボタン付近と、閉じるまで残る送信完了表示に「送信した内容・対応状況を見る」リンクを表示します（`data-feedback-history-link`）。リンク先は `/feedback/mine` で、`feedback-mine-page.tsx` を `app/feedback/mine/page.tsx`（src構成なら `src/app/feedback/mine/page.tsx`）へ自動配置します。`--no-admin-page` でも配置します。

投稿APIと同じ Supabase Cookie（分割・base64形式を含む）を Auth API で検証し、ログインユーザーのメールと `submitter_email` が一致する投稿だけをサーバーで取得します。種別・タイトル・本文・日時・状態（未対応／確認済み／対応中／完了／却下）の読み取り専用ページです。内部メモ・連絡先・添付URL・service roleキーは画面へ出しません。従来の `/feedback` は管理用です。

未ログインの場合はログイン案内、通知のみの構成では担当者への問い合わせ案内を表示します。履歴を閲覧するには Supabase 保存と投稿時のログインが必要です。別の認証方式のアプリは検証済みユーザー情報に合わせてこのページを統合してください。既存導入は `--upgrade` で更新し、フォーム表示時・送信完了時のリンクと本人の一覧を確認してください。両 verify はマーカーが無ければ「フォームに送信内容を見るリンクがありません」で不合格にします。
