# ラハイナ Instagram 自動投稿ツール群 (`tools/instagram/`)

Meta 公式の Graph API (Instagram API with Instagram Login) を使用した、ラハイナ公式 Instagram (`lahaina_ushimado`) への自動投稿およびトークン管理ツール群です。

> **ポリシー・安全規則:**
> - 非公式ライブラリ（instagrapi等）や自動化ブラウザ（Puppeteer/Playwright/Selenium等でのログイン）は**完全禁止**（アカウント停止事故の再発防止）。
> - トークン等の秘匿情報は `C:\Users\kimko\lahaina-instagram\.env` にのみ保存し、**Git リポジトリには絶対に含めない**。
> - API の成功ステータスだけでなく、公開 Web 表示の実測読み戻し検証（`verify-post.mjs`）を行う。

---

## メディア置き場の決定と理由

Instagram Graph API では、メディア（画像・動画）をローカルファイルから直接アップロードできず、**Meta のクローラーが取得できる認証不要の公開 HTTPS URL** に配置する必要があります。

### 採用決定
- **置き場**: 公開リポジトリ `kimkon1011/orgiast-claude-rules` の `media/lahaina/`
- **配信URL**: `https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/media/lahaina/<file>`

### 採用理由
1. **既存の実績**: 当該リポジトリは既に本プロジェクトの公開配布ハブとなっており、全 PC が `raw.githubusercontent.com` から取得している実績がある（`tools/onboarding-sync.mjs` / `tools/keyserve-enroll.mjs` 等）。
2. **Meta取得性**: 認証不要かつ安定した公開 HTTPS であり、Meta の Graph API サーバーから確実にダウンロード可能。
3. **コストゼロ**: 追加のインフラ契約やクラウドストレージ料金が一切不要。
4. **リポジトリ肥大化の回避**: 各 PC は clone ではなくファイル単位の raw 取得を行っているため、他 PC のチェックアウトサイズを肥大化させない（`tools/onboarding-sync.mjs` にて実測確認済み）。

### 代替手段
- **jsDelivr CDN**: `https://cdn.jsdelivr.net/gh/kimkon1011/orgiast-claude-rules@main/media/lahaina/<file>` (エッジキャッシュ有効化)
- **Genspark 生成 URL**: `tools/image-gen.mjs` が返す公開 `imageUrl` (追加ホスト不要、ただし有効期限が未検証のため一次保存推奨)

### 却下した手段
- **Vercel / Supabase Storage**: デプロイ資格情報の配布・管理が必要であり、本リポジトリに直接の連携経路がないため却下。
- **Google Drive 共有リンク**: Meta のクローラーが HTML ビューアページを取得してしまい、画像バイナリとして解釈されないため却下。

---

## 構成スクリプトと使い方

### 1. `post.mjs` (投稿 CLI)
公開 HTTPS 上の画像または動画を指定して Instagram に投稿します。

```bash
# 画像投稿 (JPEG推奨)
node tools/instagram/post.mjs --image "https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/media/lahaina/sample.jpg" --caption "ラハイナの夕日 #牛窓 #ペット宿"

# キャプションファイル指定
node tools/instagram/post.mjs --image "https://..." --caption-file "./captions/today.txt"

# リール動画投稿 (MP4)
node tools/instagram/post.mjs --video "https://.../sample.mp4" --type REELS --caption "ドッグランの様子"

# パラメータ検証のみ (API呼び出しなし・トークン不要)
node tools/instagram/post.mjs --image "https://example.com/test.jpg" --dry-run
```

主なオプション:
- `--max-per-day <n>`: 過去24時間の投稿上限ガード（既定: 10件）。上限に達している場合は exit 3 で停止。
- `--dry-run`: トークンがなくてもパラメータの JSON を出力して終了。
- `--json`: 結果を JSON で出力。

### 2. `refresh-token.mjs` (長期トークン更新 CLI・夜間バッチ用)
60日間有効な長期アクセストークンを定期的に延長・更新します。

```bash
# トークン更新 (残り10日以下の場合のみ更新)
node tools/instagram/refresh-token.mjs

# しきい値指定
node tools/instagram/refresh-token.mjs --threshold-days 14

# 判定のみ実行
node tools/instagram/refresh-token.mjs --dry-run
```

- トークン有効期限は `<envPath>.meta.json` に記録。
- トークンが発行後24時間未満の場合は Meta 側で更新できない仕様のため、エラーとせず60日仮定として記録。
- 3回連続で失敗した場合は exit 2 とともに `NOTIFY:` を出力し、無人処理を停止。

### 3. `verify-post.mjs` (実表示の読み戻し検証 CLI)
API の応答だけでなく、Instagram の公開ページを fetch して投稿やプロフィールの実態を検証します。

```bash
# 投稿パーマリンクの検証 (期待文字列が含まれるかチェック)
node tools/instagram/verify-post.mjs --permalink "https://www.instagram.com/p/DBXXXXXX/" --expect "ラハイナ"

# メディアIDから検証
node tools/instagram/verify-post.mjs --media-id "1788123456789"

# プロフィールの公開確認
node tools/instagram/verify-post.mjs --profile --username lahaina_ushimado
```

### 4. `publish-media.mjs` (メディア配置 CLI)
ローカル画像・動画を GitHub リポジトリに配置するか、公開URLを事前検証します。

```bash
# 公開URLの事前検証 (HEAD/GETでHTTP 200および画像/動画Content-Typeか確認)
node tools/instagram/publish-media.mjs --check-url "https://raw.githubusercontent.com/.../photo.jpg"

# ローカルファイルをGitHub Contents APIで配置 (GITHUB_TOKENが必要)
node tools/instagram/publish-media.mjs --file "./photo.jpg"
```

---

## 認証情報・環境設定
- ファイルパス: `C:\Users\kimko\lahaina-instagram\.env`
- 書式例:
  ```env
  INSTAGRAM_ACCESS_TOKEN=IGQ...
  INSTAGRAM_USER_ID=178414...
  INSTAGRAM_USERNAME=lahaina_ushimado
  ```
- メタデータファイル: `C:\Users\kimko\lahaina-instagram\.env.meta.json`
- 投稿履歴ログ: `C:\Users\kimko\lahaina-instagram\post-log.jsonl`

---

## ⚠️ 2026-10-15 実測: 公開プロフィールは素の HTTP では読めない（検証計画の修正）

`verify-post.mjs --profile` をこの PC から実行した実測結果:

```
unverified: https://www.instagram.com/lahaina_ushimado/
  (サーバー描画メタ無し（JSシェル）。素のHTTP取得では実表示を確認できない)
```

判明したこと:

1. `https://www.instagram.com/lahaina_ushimado/` は **HTTP 200 / 637KB** を返すが、中身は
   `<title>Instagram</title>` のみの **JS シェル**で、`og:title` / `og:description` /
   フォロワー数 / bio が一切含まれない（クライアント側レンダリング）。
   → **引継書 §5 の「ブラウザで開いて実表示を読み戻す」は、素の HTTP fetch では不可能。**
2. 途中で「ログインウォール」と誤判定していたが、原因は `isLoginWall()` が
   `"httpErrorPage"` を検出していたこと。この文字列は Instagram の**通常ページの JS バンドルにも入っている**
   ため誤検知だった（修正済み・回帰テストあり）。

**帰結（2026-10-20 に解決）**: 投稿後の「実表示」検証は次の3案を比較し、**(b) の派生＝ログイン不要のヘッドレスChrome描画**を採用した。

| 案 | 判定 | 理由 |
|---|---|---|
| (a) 人の目視 | 不採用（補助） | 追加実装ゼロだが毎回の手作業になる。§1.1（user の手間ゼロ）に反する |
| (b) ヘッドレスブラウザで公開ページを描画 | **採用** | ログイン不要・追加トークン不要。§7 の禁止事項は「ログインにブラウザを使うこと」であり、公開ページの閲覧は該当しない |
| (c) Graph API `/me/media` | 補助として併用 | API 応答だけでは「実表示」の証拠にならない（引継書 §5）。`--via graph` として残置 |

**実測（2026-10-20・このPC）**: Chrome `--headless=new --dump-dom` で
`https://www.instagram.com/lahaina_ushimado/` を描画すると `og:title`・`og:description`
（「フォロワー1,149人、投稿166件」）が取れ、`/p/Ddf_thXPDK_/` では描画後DOMに
`"caption":{"text":"ラハイナPVです…"}` が入っていた。素の HTTP では両方とも JS シェル/`httpErrorPage` のまま。

使い方:

```bash
# 投稿の実表示を描画して読み戻す（ログイン・トークン不要）
node tools/instagram/verify-post.mjs --permalink "https://www.instagram.com/p/XXXX/" --via render --expect "ラハイナ"

# プロフィールの実表示を描画して読み戻す
node tools/instagram/verify-post.mjs --profile --via render

# トークンがある場合は API を正本にできる（補助証拠）
node tools/instagram/verify-post.mjs --permalink "https://www.instagram.com/p/XXXX/" --via graph
```

`--via auto` は従来どおり「トークンがあれば graph、無ければ html」で、`render` は明示指定。
描画に失敗した場合（Chrome 不在・削除済み等）は `unverified` を返し、成功扱いにしない。
