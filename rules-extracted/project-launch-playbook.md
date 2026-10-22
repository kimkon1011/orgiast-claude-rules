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

### 1.12.1 移管前提の設計ルール（詳細版・kim 2026-10-22 厳命・全PC全アカウント全 Claude Code）

すべての新規プロジェクトは「後で cr@orgiast.jp など別アカウントへ管理を移す」前提で作る。ONBOARDING.md §1.12.1 の要約の詳細版。

背景: 2026-10 に古川さん退職に伴うアプリ5本の cr@orgiast.jp への移管、ブース制作アプリの cr-PC 移管で、個人アカウント依存（Vercel Hobby のメンバー不可・個人 Discord ID のハードコード・env の所在不明・引き継ぎ文書なし）が移管コストの大半だった。

#### 設計ルール
1. 着手時の所有権宣言（§1.12 の標準応答テンプレ）に「移管先候補」と「移管手順の所要（分）」を1行添える。未定なら「cr@orgiast.jp 等の社内アカウント」。
2. 外部リソースは最小。原則 GitHub + Cloudflare（DB は D1）。Vercel / Supabase / GCP / 有料 SaaS を足すときは理由を1行書き、HANDOVER.md のリソース一覧に移管手順まで書く。
3. 個人アカウントに紐づく値（Discord ID・メールアドレス・トークン・Webhook URL・スプレッドシート ID）は env / Binding / Script Properties に置く。`.env.example` に全項目を説明付きで列挙する。
4. リポジトリ直下に `HANDOVER.md`（下のひな形）。README に「引き継ぎは HANDOVER.md」と1行書く。非エンジニアの後任が読んで移管を完了できる粒度にする。
5. 移管が「招待してオーナー変更」で終わる構成にする。GitHub = Transfer ownership（または Org 配下で Owner 追加）、Cloudflare = Members → Super Administrator、Google = 同一ドメイン内の所有権移転、GAS = clasp + GitHub 管理。個人の有料プランでしか成立しない構成や、個人 PC のローカルにしか無い秘密・定期ジョブは作らない（定期処理は GitHub Actions / Cloudflare Cron Triggers / GAS トリガー）。
6. デプロイ前ゲート: `tools/handover-doc-gate.mjs` が `wrangler deploy` / `wrangler pages deploy` / `vercel deploy` / `vercel --prod` / `clasp push` / `npm run deploy` の直前に HANDOVER.md の有無を確認し、無ければ deny する。緊急時のみ `HANDOVER_GATE_SKIP=1`。
7. 既存アプリは大きな改修のついでに同じ形へ寄せる。HANDOVER.md の追加だけなら改修を待たずその場で行う。
8. 完了報告の検証表に「HANDOVER.md あり／移管手順の所要（分）」の行を入れる。

#### HANDOVER.md ひな形

```markdown
# HANDOVER.md（引き継ぎ書）

## このアプリは何か
<1〜3行。URL・用途・利用者>

## リソース一覧
| 種別 | 名前 | 現オーナー（アカウント） | URL | 移管手順 | 移管後に書き換える箇所 |
|---|---|---|---|---|---|
| GitHub repo | owner/name | kimkon1011 | https://github.com/... | Settings → Danger Zone → Transfer ownership → 新オーナーが承諾 | README のリンク、Actions の secrets |
| Cloudflare Workers | name | kim@orgiast.jp | https://dash.cloudflare.com/... | Manage Account → Members → 招待 → Super Administrator → 旧オーナー削除 | なし（アカウント共有のため） |
| Google スプレッドシート | 名前 | seisaku-team@orgiast.jp | https://docs.google.com/a/orgiast.jp/... | 共有 → 所有者を変更 | env の SHEET_ID は不変 |

## env / secrets（値は書かない）
| 名前 | 用途 | 所在（どこで発行・どこに保存） |
|---|---|---|

## 定期ジョブ・外部連携
| 種別 | 場所 | 何をする | 止め方 |
|---|---|---|---|

## 再デプロイ手順
~~~
npm ci
npm run build
npm run deploy
~~~

## ローカル起動
~~~
cp .env.example .env.local   # 値は上の表の所在から取得
npm run dev
~~~

## 移管チェックリスト
- [ ] 上の全リソースで新オーナーが Owner/Super Admin になった
- [ ] 新オーナーの PC で `npm run deploy` が通った
- [ ] 旧オーナーの権限を外した（またはメンバーとして残す判断を記録）
- [ ] この文書の「現オーナー」列を更新した
```
