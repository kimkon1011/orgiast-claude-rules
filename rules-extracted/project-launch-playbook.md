# プロジェクト立ち上げ標準プレイブック 詳細

ONBOARDING.compressed.md §1.8 / §1.9 / §1.10 / §1.12 の詳細。

## 1.8 プロジェクト立ち上げの「自動化可能/不可」分類

新規 orgiast 系プロジェクトを立ち上げるとき、以下の分類に従って自動化可能なものは絶対に user に手作業させない。

### ✅ 完全自動化可能(これらを手作業依頼したら違反)

| 操作 | ツール |
|---|---|
| GCP プロジェクト作成 | `gcloud projects create` |
| Cloud API 有効化(Sheets/Drive/Gmail 等) | `gcloud services enable sheets.googleapis.com ...` |
| サービスアカウント作成 + JSON キー | `gcloud iam service-accounts create` + `keys create` |
| IAM ロール付与 | `gcloud projects add-iam-policy-binding` |
| GitHub repo 作成・secrets・Collaborator | `gh repo create` / `gh secret set` / `gh api` |
| Vercel link / env / deploy | `vercel link` / `vercel env add` / `vercel --prod` |
| Supabase migration / link / type 生成 | `supabase login` / `link` / `db push` / `gen types` |
| Discord 通知 | Webhook URL を保存しておけば API 1発 |
| Google Sheets / Drive / Gmail データ操作 | サービスアカウント + googleapis、または DWD |

### ⚠ 自動化不可だが超軽量(user の 1 クリック / 1 入力で済む)

| 操作 | 軽量化策 |
|---|---|
| 各種サービスへの 初回ログイン (`gcloud auth login`, `gh auth login` 等) | 1回だけ、その後 Claude 完結 |
| OAuth Web Client 作成(GCP Console UI でしかできない) | DWD で回避できる場合は回避する(下記) |
| OAuth 同意の Allow ボタン | 直 URL を提示して1クリックのみ |
| API トークン発行(ChatWork / LINE 等のパスワード認証必要なもの) | 発行ページの直 URL + トークン貼り付け箇所だけ案内 |
| 第三者サービスの 新規アカウント作成(電話/メール認証必要) | 説明は最小、登録 URL を直で渡す |
| Workspace 管理者の DWD 委任設定 | 1 回だけ、その後 OAuth 不要 |
| 支払い情報入力 | URL のみ提示、こちらは触らない |

### 🚫 「OAuth Web Client 作成」を回避する代替策

- Gmail / Drive 等 Google API の per-user OAuth は Domain-wide Delegation (DWD) で代替可能
  - kim さんが Workspace 管理者 → Admin Console で SA に scope 委任を 1 回設定すれば、OAuth Web Client 不要
  - サーバ側で任意ユーザー(seisaku-team@orgiast.jp 等)を impersonate できる
- Supabase Auth の Google ログインは OAuth Web Client 必須 ← これは回避策なし、観念して GCP Console UI で作る

## 1.9 プロジェクト立ち上げの標準シーケンス

新規 orgiast 系プロジェクトの定型フロー。user に頼むのは最後の「6.」だけ にする。

```
1. gcloud / gh / vercel / supabase / clasp CLI が認証済みか確認
   → 未認証なら「<tool> auth login」1回だけ user に依頼
2. GCP プロジェクト作成 / API 有効化 / SA 作成 / JSON 取得 → 全部 gcloud で完結
3. Supabase プロジェクト → CLI 作成(初回 org 作成のみ手動、それも他プロジェクトと共用なら不要)
4. GitHub repo → gh で作成 + push
5. Vercel link + env 投入 + deploy → vercel CLI
6. ★最後にここだけ★ 通知/連携系のトークン取得(ChatWork / LINE / Facebook / Discord Webhook)
   → user が web UI で取得 → 貼り付けてもらう → こちらで env 投入 + 再デプロイ
```

過去に user に手作業を頼んだ操作で、本来 1~5 の範囲だったもの:
- GCP プロジェクト作成(本来 gcloud で自動化可能、私の gcloud 未インストールが原因で手作業依頼してしまった)
- Sheets API / Drive API 有効化(同上)
- サービスアカウント JSON ダウンロード(同上)
- Vercel env 投入(本来自動化済みだが classifier に止められて user 承認要求した)

→ gcloud CLI を私の環境に入れておくことが必須。同様に supabase CLI も。

## 1.10 CLI 未インストールは自分で install する

「○○ CLI が私の環境に無いから手作業で…」は完全 NG。
Windows なら winget(or scoop/choco/npm)で自動インストールする。

| ツール | install コマンド |
|---|---|
| gcloud | `winget install --id Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements` |
| supabase | `winget install Supabase.CLI` or `npm i -g supabase` |
| gh | `winget install GitHub.cli` |
| vercel | `npm i -g vercel` |
| clasp | `npm i -g @google/clasp` |

インストール後の認証(`gcloud auth login` 等)だけが「user 1 クリック」の許容範囲。

## 1.12 アカウント所有権の事前宣言ルール

新規 orgiast プロジェクトの 着手初手で必ず、各リソースをどのアカウントで作るかを宣言してから着手する。途中で気づくと recover の手間が発生する。

### デフォルトのアカウント割り当て

| リソース | 推奨アカウント | 理由 |
|---|---|---|
| GCP プロジェクト(SA・OAuth client・API enable) | seisaku-team@orgiast.jp | チーム共有、属人化回避 |
| Supabase プロジェクト | seisaku-team@orgiast.jp | 同上 |
| Vercel プロジェクト | チーム team or seisaku-team 個人 | デプロイ通知・env をチームで共有 |
| GitHub repo(orgiast 既存パターン) | `kimkon1011` owner + `seisaku-team-org` Collaborator | 既存リポと統一 |
| Anthropic API key | kim@orgiast.jp の Console org | 請求集約 |
| ChatWork API token | seisaku-team@orgiast.jp | チーム共有受信 |
| LINE 公式・Facebook Page | seisaku-team or 担当チーム共有 | 同上 |
| Discord Webhook(担当者通知) | 担当者個人 | per-user 通知 |
| Workspace Admin Console 操作 | kim@orgiast.jp のみ可能 | super admin |

### 立ち上げ時の標準応答テンプレ

```
新規プロジェクト着手します。以下のアカウントで作成します(変更あれば指示してください):
  - GCP project: seisaku-team@orgiast.jp
  - Supabase: seisaku-team@orgiast.jp
  - Vercel: ...
  - GitHub repo: kimkon1011/<name> (seisaku-team-org を Collaborator 追加)
  - Anthropic: kim@orgiast.jp console org
これで問題なければ着手します。
```

### 間違ったアカウントで作ってしまった時の recover

- GCP: https://console.cloud.google.com/iam-admin/iam?project=<PROJECT_ID> → 「+ ADD」で正しいメアド + Owner role
- Supabase: https://supabase.com/dashboard/org/<slug>/team → Invite member
- Vercel(Hobby): メンバー追加に Pro plan 必要 → 個人 owner のまま運用
- GitHub: Settings → Collaborators で追加
