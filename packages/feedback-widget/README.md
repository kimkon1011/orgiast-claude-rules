# 全社標準 アプリ内フィードバック

オージャスト社内の Next.js アプリへ、不具合・要望フォーム、Discord 通知、管理キューを1コマンドで導入する標準パッケージです。追加 npm パッケージは不要です。

```sh
node -e "fetch('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/install.mjs?cb='+Date.now()).then(r=>r.text()).then(t=>{require('fs').writeFileSync('install-feedback.mjs',t);})" && node install-feedback.mjs --app-name "<アプリ名>"
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
