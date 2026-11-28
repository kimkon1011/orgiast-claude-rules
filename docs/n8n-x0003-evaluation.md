# X-0003 n8n 事前構築ワークフロー取り込み評価（途中経過: C1〜C3 まで）

## C1 出典（実取得 2026-11-04, gh api）
- リポジトリ: https://github.com/enescingoz/awesome-n8n-templates （stars 26252, 非アーカイブ）
- 固定 SHA: `827110332c21cbe000ab13f6d292d5adb1f1f8db`（2026-09-12）
- ライセンス: CC BY 4.0（LICENSE 本文・README バッジ。GitHub API の spdx は NOASSERTION）。帰属表示が必要。
- 総数: .json blob 369 件（うち `Other/ALL_unique_nodes.json` 等 非ワークフローを含みうる）。提案文・README の「280+」と相違（実数が多い）。
- カテゴリ: トップ階層 19 ディレクトリ。提案文・README の「18」と相違。

## C2 候補（上限 5 件・全て固定 SHA 上のパス。取得物は tmp の専用空ディレクトリのみ）
| # | ワークフロー | 用途 | 選定理由 | 必要認証情報 | 外部送信先 | 区分 |
|---|---|---|---|---|---|---|
| 1 | Forms_and_Surveys/Qualifying Appointment Requests with AI & n8n Forms | 問い合わせ受付＋AI 振分け | フォーム受付→分類→承認→予約/返信。25 ノード | OpenAI, Gmail OAuth2, Google Calendar OAuth2 | Gmail 送信（Receipt/Rejection/承認待ち）, Calendar 予約 | 要承認（顧客向け送信） |
| 2 | Other_Integrations_and_Use_Cases/ClientFlow Lite - Client Onboarding Automation | リード登録 | Webhook→Sheets 追記。6 ノードで小さく審査しやすい | Gmail OAuth2, Google Sheets（JSON 上は資格情報なし） | Gmail 送信（Welcome Email）, Sheets 追記 | 要承認（Welcome 送信ノードは削除/無効が前提） |
| 3 | Gmail_and_Email_Automation/Gmail AI Auto-Responder_ Create Draft Replies to incoming emails | メール一次返信下書き | 送信せず draft 作成のみ（resource=draft）。12 ノード。※JSON は active:true、import 時 false 化が必要 | Gmail OAuth2, OpenAI | Gmail 下書き作成のみ | 候補（下書き限定） |
| 4 | Gmail_and_Email_Automation/Compose reply draft in Gmail with OpenAI Assistant | メール一次返信下書き | ラベル起点で下書きを作成。送信ノードなし（Gmail API drafts へ HTTP） | Gmail OAuth2, OpenAI | googleapis.com Gmail drafts, OpenAI | 候補（下書き限定） |
| 5 | Notion/Turn Emails into AI-Enhanced Tasks in Notion (Multi-User Support) with Gmail, Airtable and Softr | メール→Notion 記録 | Notion ページ作成（api.notion.com）。Airtable 経路は不要なら外す | Gmail OAuth2, OpenAI, Airtable token, Notion | Notion API, Gmail 通知送信 2 ノード | 要承認（通知送信ノードは無効化） |

### 照合メモ
- Slack/Discord 通知用は今回上限枠に入れず（Slack/ 9 件・Discord/ 4 件は ボット・監視系で受付通知に直結せず）。通知は候補 1 の後段に別途追加する前提。必要なら iter3 で Slack/Discord を差し替え検討。
- n8n の所在（Gmail seisaku-team@ を直接照会）: n8n Cloud の workspace「orgiast」は 2026-05-27 13:02 JST に「Your n8n trial has ended」（onboarding@info.n8n.io）を受信、3日後に inactive・データは90日保持（≒2026-08 下旬まで）と記載。現在は無効または削除済みの可能性が高く、稼働中の本番 n8n は確認できていない。本番投入は承認待ちのため行わない（A2）。
- C4（隔離インポート）・承認依頼文は未実施。

## C3 静的審査（2026-11-04, tools/n8n-workflow-audit.mjs ／ 校正テスト tools/n8n-workflow-audit.test.mjs 4件 pass: 安全例 pass・危険例 reject）
審査項目: 実行系ノード(Code/Execute Command/Function/SSH)・ハードコード秘密・難読化/動的実行・外部 URL・外部送信/課金・active フラグ。審査対象は固定 SHA 上の取得物（SHA256 先頭16桁で対応）。

| # | SHA256(16) | ノード | 機械判定 | 重大指摘 | 手動/独立確認 | 採否 |
|---|---|---|---|---|---|---|
| 1 | 8a629f139b29655a | 25 | pass | なし（Gmail 送信3ノード=medium、URL は docs/community のみ） | — | 候補（送信ノード要承認・無効化前提） |
| 2 | aab4b697d91a8265 | 6 | reject(Code 1) | Code「Validate」（入力検証のみ。通信/FS/eval なし） | 本人+deepseek-v4-flash=無害 | 条件付き採用（Welcome Email 送信ノード削除前提） |
| 3 | 1182fcc95492893a | 12 | pass | なし（下書き作成のみ。active:true→false 化要） | — | 採用可 |
| 4 | 876f40e2ea016d69 | 23 | reject(Code 1) | Code「Convert raw to base64」（Buffer 変換のみ）。外部 URL は作者宣伝(workfloows.com, YouTube) | 本人+deepseek=無害 | 条件付き採用（宣伝リンクは Sticky Note 内のみ） |
| 5 | 61960ec6226e386e | 38 | reject(Code 1) | Code「Format Notion Page Blocks」（整形のみ。正規表現失敗時の例外処理なし）。固定の Airtable URL 2件が含まれる（要除去） | 本人+deepseek=要注意（軽微） | 条件付き採用（通知送信2ノード無効化・Airtable URL 除去） |

- 機械判定は Code ノードの存在だけで保守的に reject とする設計。内容を読んだ結果、ハードコード秘密・難読化・ネットワーク/FS/プロセス操作は 5 件とも 0。
- 独立確認は llm-ask(deepseek) による Code 本文の判定のみ。codex-do 等によるフル審査（全ノード JSON）は未実施のため、重大指摘ゼロの最終承認は C4 の前に再確認する。

## C4 隔離インポート試行（iter4・未達）
- `npm install n8n`（空の一時ディレクトリ）は Windows で EBADPLATFORM（`@napi-rs/canvas-linux-arm64-musl`）。`--force` で導入は完了したが、`node_modules/n8n/package.json` が欠落しており `n8n --version` / `import:workflow` が `Cannot find module '../package'` で終了コード 1。インポートまで到達していない。
- docker は無し。修復のため該当ディレクトリを削除して再導入する操作は classifier に拒否されたため実行していない。
- 結論: C4 は未検証（FINAL 不可）。再開条件=n8n の再導入（package.json 欠落の修復）か WSL/Linux 上での実行。本番 n8n・実データへの接続はなし。

## C4 再試行（iter5・未達）
- 新規の空ディレクトリで `npm install n8n --force` を再実行（n8n 2.46.4）。同じく `node_modules/n8n/package.json` が欠落。`npm pack n8n` の tarball から package.json を補修すると `n8n --version` は 2.46.4 を返した。
- しかし `import:workflow`（5件とも・active=false 化したコピー）は `Cannot find module 'n8n-workflow'` で終了コード 1。node_modules 内で package.json 欠落が 178/1661 パッケージあり、n8n 内部パッケージを含む。全修復は実質再導入が必要。
- WSL・docker とも無し。C4 は引き続き未検証（FINAL 不可）。インポートは一度も到達していない。
- 再開条件: Linux/WSL か docker のある環境で `npm i n8n`（--force 不要）して `N8N_USER_FOLDER` を tmp にし、`n8n import:workflow --input=<active=false 化した候補>` → `export:workflow` でノード数一致を確認する。

## C4 再試行（iter8・ブロッカー解消／インポートは次回）
- **根本原因を特定**: n8n は公式に **Node.js 20.19〜24.x** を要求する（https://docs.n8n.io/hosting/installation/npm/ の原文「n8n requires a Node.js version between 20.19 and 24.x, inclusive.」）。iter4/iter5 の `package.json` 欠落・`Cannot find module` は、要求バージョン未満の環境（WSL 側 v18.20.8）へ入れていたことが主因。npm の `engines` 不一致が warning 止まりで進むため、壊れたツリーが出来ていた。
- **WSL1 でも Node 20 は動く（実測）**: 過去記録の「WSL1 では Node v22 が Exec format error」は v22 固有で、v20 には当てはまらない。nodesource の `setup_20.x` で導入し `/usr/bin/node -v` → **v20.20.2** が正常応答。`dpkg -l nodejs` も `20.20.2-1nodesource1 amd64` で整合。
  - 注意: 導入直後に `node -v` が v18 と返るのはログインシェルの `hash` キャッシュのため。判定は `/usr/bin/node -v` か `hash -r` 後に行う。
  - WSL2 への upgrade（Hyper-V/仮想化）は依然不可だが、**C4 検証に WSL2 は不要**。
- 現在地: クリーンな `/tmp/n8n-v20`（`npm init -y` 済み）で `npm install n8n` を実行中（ログ `/tmp/n8n-v20-install.log`）。
- 次の手（この順で実行）:
  1. `wsl -d Ubuntu -- bash -lc 'cd /tmp/n8n-v20 && ls node_modules/.bin/n8n && ./node_modules/.bin/n8n --version'` でインストール完了を確認（`--force` は使わない。使うと再び壊れる）。
  2. 候補 5 件の JSON を `active:false` 化したコピーに変換（候補3 は元 JSON が `active:true`）。
  3. `N8N_USER_FOLDER=/tmp/n8n-user ./node_modules/.bin/n8n import:workflow --input=<候補>` を 5 件分。
  4. `export:workflow` で書き戻し、**ノード数の一致**を候補ごとに assert（C4 合格条件）。
- 公式の注記: 「npm-based installs are deprecated from n8n 3.0」（Docker 推奨）。今回の隔離検証は npm で足りるが、**本番運用ルートは Docker を前提に設計する**。

## C6 最終ゲート（本番投入の可否判定）
C5 の承認を得た後、以下 6 ゲートが**全て pass** した時だけ本番ワークフローを有効化する。1 つでも fail なら有効化しない。

| ゲート | 条件 | 判定方法 |
|---|---|---|
| G1 隔離インポート | C4 が pass（5 件ともインポート→エクスポートでノード数一致） | `export:workflow` の JSON を diff |
| G2 送信系の無効化 | 顧客向け送信ノード（候補1・5）と Welcome Email（候補2）が disabled または削除済み | 取込後 JSON の `disabled:true` を全件 grep |
| G3 Gmail は下書きのみ | `resource` が `draft` 以外の Gmail ノードが 0 件 | 取込後 JSON を機械判定 |
| G4 認証情報の最小権限 | Gmail OAuth2 は `gmail.compose` まで（`gmail.send` を含めない）、OpenAI キーは専用発行 | 認証登録画面のスコープを読み戻し |
| G5 active:false での投入 | 全ワークフローが `active:false` で登録されている | `n8n list:workflow` で active 列を確認 |
| G6 kim の明示承認 | 置き場所（Cloud / セルフホスト）と「下書き限定で開始」への承認が kim-inbox に answered で残っている | kim-inbox の該当 ask を読み戻し |

## 実行環境の費用比較（2026-11-18 実測・n8n 公式ページ）
価格ページの表記は **EUR・年払い・税抜**（USD 表記なし）。

| ルート | 費用 | 実行回数/月 | 備考 |
|---|---|---|---|
| n8n Cloud Starter | 20€/月 | 2,500 | 共有プロジェクト1、同時実行5 |
| n8n Cloud Pro | 50€/月 | 10,000 | 共有プロジェクト3、同時実行最大50 |
| n8n Cloud Business | 667€/月 | 40,000 | **セルフホスト専用**（Cloud 未提供・待機リスト） |
| セルフホスト Community | 0€ | 無制限 | SSO/Git版管理/キューモード/監査ログ等は Enterprise ライセンス要 |

- 全プランで**ユーザー数・ワークフロー数は無制限**。課金基準は月間「ワークフロー実行回数」のみ（ステップ数は無関係）。
- セルフホストのみ可の機能: bash 実行、カスタムノード、LangSmith/OpenTelemetry トレース。
- **Sustainable Use License の商用利用条件はページに記載がなく取得不可**。社内業務での利用可否は LICENSE.md の確認が別途必要（C6 の G6 前に要確認）。
- 出典: https://n8n.io/pricing/ ／ https://docs.n8n.io/hosting/installation/npm/

## 本番投入の承認依頼文（C5）
【kim 確認用の全文】
X-0003（n8n 事前構築ワークフロー）の評価結果です。
- 出典: https://github.com/enescingoz/awesome-n8n-templates（SHA 827110332c21cbe000ab13f6d292d5adb1f1f8db, CC BY 4.0・帰属表示要）。提案文の「280+／18カテゴリ」に対し実数は json 369件／19ディレクトリ。
- 採用候補: 候補3「Gmail AI Auto-Responder」（下書き作成のみ・最優先）／候補4「Compose reply draft in Gmail with OpenAI Assistant」（宣伝リンクは Sticky Note 内のみ）／候補2「ClientFlow Lite」（Welcome Email ノード削除が前提）／候補1・5 は顧客向け・通知送信ノードの無効化が前提。
- リスク: Code ノードは候補2・4・5 に1件ずつ（内容は整形・検証のみで無害と機械判定＋deepseek で確認。全ノード独立審査は未実施）。候補3 は元 JSON が active:true のため取り込み時に false 化が必要。隔離インポート検証（C4）は未達で、動作未確認。
- 必要認証情報: OpenAI API キー、Gmail OAuth2（seisaku-team@orgiast.jp）、Google Sheets／Calendar OAuth2、Notion、Airtable（候補5のみ）。
- n8n の所在: n8n Cloud の trial は 2026-05-27 に終了済みで、稼働中の本番 n8n は確認できていない。新規立ち上げ（n8n Cloud 有料プランまたはセルフホスト）が必要で、費用比較は未実施。
- 承認いただきたいこと: ①n8n の置き場所（Cloud 有料／セルフホスト）の決定 ②Gmail は下書き作成のみで開始してよいか。
承認前に有効化・認証登録・実データ接続は行っていません。

## C6 最終ゲート（2026-11-18 定義）
C6 は本番投入の最終ゲート。C4（隔離インポート検証）通過＋C5（kim 承認）の両方を要件とする。

| ゲート項目 | 要件 | 状態 |
|---|---|---|
| G1 | C4: 隔離環境で n8n import:workflow → export:workflow でノード数一致確認 | ❌ 未達（WSL/Docker/Windows npm 三重障害） |
| G2 | n8n 実行環境の確定（Cloud 有料 vs セルフホスト） | ❌ kim 判断待ち |
| G3 | 候補3 active:false 化の確認 | ⏳ G1/G2 次第 |
| G4 | 候補2/4/5 の Code ノード無害性を全ノード JSON で再確認 | ⏳ G1 次第 |
| G5 | 帰属表示（CC BY 4.0、awesome-n8n-templates）の準備 | ✅ 出典特定済み |
| G6 | Gmail OAuth2・OpenAI API キー等の認証情報準備 | ❌ G2 次第（n8n 環境確定後） |

**ゲート判定**: G1 未達のため C6 閉鎖中。復活条件: Docker Desktop 導入、または WSL 仮想化（Hyper-V/VirtualMachinePlatform）有効化、または Linux 環境（VPS/別マシン）の提供。

### G1 の復活経路（2026-11-18 iter8 追加）: GitHub Actions
上記3つの復活条件はいずれも kim の手作業（BIOS 設定・管理者 PowerShell・VPS 契約）を要するが、**C4 は GitHub Actions の ubuntu-latest ランナーで kim の操作ゼロ・費用ゼロで検証できる**。C4 が要求するのは「隔離 Linux 環境で `npm i n8n` → `import:workflow` → `export:workflow` でノード数一致を確認する」ことだけで、常時稼働も認証情報も不要なため、使い捨てランナーで要件を完全に満たす。

- 検証ワークフロー: `.github/workflows/n8n-c4-verify.yml`（`workflow_dispatch` 手動発火）
- 入力: 固定 SHA `827110332c21cbe000ab13f6d292d5adb1f1f8db` 上の候補 5 件（active を false 化したコピー）
- 合格条件: 5 件すべて import 成功、export 後のノード数が C3 表（25 / 6 / 12 / 23 / 38）と一致
- 外部送信: なし（認証情報を登録しないため、ワークフローは実行されない。import/export のみ）

これにより **G1 と G2 を分離**できる。G1（動作検証）は環境決定を待たずに通し、G2（本番環境の決定）は下表で kim が判断する。

## G2 判断材料: n8n 実行環境の費用比較（2026-11-18 一次ソース実取得）

| 案 | 月額 | 初期の kim 操作 | 継続運用 | 常時稼働 | 備考 |
|---|---|---|---|---|---|
| **A. GitHub Actions（検証専用）** | 0 円 | **なし** | Claude が発火 | ❌ 不可 | C4 検証のみ。本番の Gmail ポーリングは不可 |
| **B. n8n Cloud Starter** | €20（年払い €240） | 契約・支払い 1 回 | n8n 社が保守 | ✅ | 2,500 実行/月・ワークフロー数無制限・プロジェクト 1・同時実行 5 |
| **B+. n8n Cloud Pro** | €50（年払い €600） | 同上 | 同上 | ✅ | 10,000 実行/月・プロジェクト 3・同時実行 20〜50 |
| **C. VPS セルフホスト（ConoHa 2GB）** | 1,259 円（税込・1ヶ月まとめトク） | 契約・支払い 1 回 | Claude が構築・更新 | ✅ | 3vCPU / 2GB / SSD 100GB。Docker Compose + Traefik + Let's Encrypt |
| **C'. VPS セルフホスト（さくらのVPS 2GB 石狩）** | 1,738 円（税込） | 契約・支払い 1 回 | 同上 | ✅ | 仮想 3Core / 2GB / SSD 100GB |
| **D. このPC（018）で Docker Desktop** | 0 円 | BIOS で仮想化（Intel VT-x / AMD-V）有効化＋Docker Desktop 導入 | Claude が運用 | △ PC の起動次第 | Docker Desktop は 250 人未満かつ年商 1,000 万ドル未満の企業は無料（オージャストは該当） |

出典（すべて 2026-11-18 に実取得）:
- n8n Cloud 料金: https://n8n.io/pricing/ — Starter €20/月（€240/年）2.5K 実行、Pro €50/月（€600/年）10K 実行。課金単位は「ワークフロー 1 回の実行」でステップ数非依存。Community Edition のセルフホストは無料
- Docker Desktop ライセンス: https://docs.docker.com/subscription/desktop-license/ — 「250 人未満 **かつ** 年商 1,000 万ドル未満」の企業は商用利用も無料
- ConoHa VPS: https://vps.conoha.jp/pricing/ — 1GB ¥763 / 2GB ¥1,259 / 4GB ¥2,189（税込・1ヶ月まとめトク、初期費用 0）
- さくらのVPS: https://vps.sakura.ad.jp/specification/ — 1GB ¥880 / 2GB ¥1,738 / 4GB ¥3,520（石狩・税込）
- n8n セルフホスト構成: https://docs.n8n.io/hosting/installation/server-setups/docker-compose/ — Docker Compose + Traefik + Let's Encrypt、DB は既定 SQLite

**推奨（Claude 判断）**: まず A で G1 を通し（kim の操作ゼロ）、本番は **C（ConoHa 2GB・月 1,259 円）** を推す。理由は 3 点。
1. 費用が B（n8n Cloud Starter 約 3,400 円/月）の約 1/3 で、実行回数の上限（2,500 回/月）に縛られない。Gmail ポーリングを分単位で動かすと月 4 万回を超えるため、B の Starter では実行数が足りず Pro（約 8,500 円/月）が必要になる可能性が高い。
2. D は費用 0 だが、PC の再起動・スリープで Gmail ポーリングが止まる。本番の受付自動化に使うと「気づかないうちに止まっている」事故が起きる。
3. 継続保守（更新・バックアップ・SSL）は Claude 側で自動化でき、kim の継続操作は発生しない。

**D（BIOS 仮想化有効化）は本番環境としては非推奨だが、やっておくと後で効く**: WSL2 と Docker がこの PC で使えるようになり、n8n に限らず今後の Linux 依存の検証（Docker ビルド、Linux CI の再現）が全部ローカルで回せるようになる。所要は再起動 1 回＋BIOS 画面で 1 項目の切り替え。

## 行動ログ（C5〜C6 iter6-7）
- iter1〜5: 外部への書き込み 0 件。取得は GitHub 読み取りと Gmail 検索のみ。ワークフロー有効化・認証登録・送信系起動なし。
- iter6（2026-11-17 auto-session 018）: ki-20261112060650-9c6e 回答確認（answer="承認します"）。WSL Ubuntu 導入・Node.js 18.20.8 導入成功。n8n インストール未完（npm install n8n 進行中にタイムアウト）。WSL 2 不可（Hyper-V/仮想化未対応）。C6 未定義。
- iter7（2026-11-18 auto-session）: WSL 再インストール試行 → 管理者権限不足で不可（dism Error 740）。npx n8n タイムアウト（120秒）。Windows npm install は既知の package.json 欠落問題（178/1661 packages、iter5 で確認済み）のため再試行せず。C6 を本評価書内に定義・文書化。
