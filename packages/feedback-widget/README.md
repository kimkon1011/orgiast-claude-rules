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

## 導入状況

| アプリ | 状況 |
|---|---|
| aujust-sales-automation | 手移植済み・本番稼働 |
| anniversary-mail | 手移植済み |
| assign-app | 本パッケージで導入予定 |

## 運用

社員がアプリ内から投稿 → Discord へ通知 → 開発側が `node scripts/list-feedback.mjs` で未対応キューを取得 → 実装 → `/feedback` で status を `done` に更新、という流れです。導入後は、パッケージ一式が手元にあれば `node packages/feedback-widget/verify.mjs --url https://<app>.vercel.app --target <repo>`、1行導入で `verify.mjs` が無ければインストーラーが表示するダウンロード + 実行コマンドで投稿と read-back を検証します。詳細は [INSTALL.md](./INSTALL.md) を参照してください。
