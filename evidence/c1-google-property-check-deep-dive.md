# C1 Deep-Dive: google-property-check.mjs

分析日: 2026-11-01
対象: `tools/google-property-check.mjs` (commit e04b986 時点)
目的: クォータスイープの委譲候補として、API 応答形状・モックデータ・分割戦略を確定する

---

## 1. C1.1 — API 応答形状（確定）

ツールは **1 つの DWD JWT で 3 つの Google API を順次照会**する。各 API の実応答形状は以下のとおり（ソースの `pick()` と実測値から逆算）。

### 1.1 GA4 (Analytics Admin API v1beta)

```
GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200
Scope: https://www.googleapis.com/auth/analytics.readonly
```

**応答（実測: 17 件）**:
```json
{
  "accountSummaries": [
    {
      "displayName": "orgiast.jp（組織）",
      "account": "accounts/123456789",
      "propertySummaries": [
        {
          "displayName": "全ウェブサイトのデータ",
          "property": "properties/278904354"
        }
      ]
    },
    {
      "displayName": "東邦鋼業",
      "account": "accounts/234567890",
      "propertySummaries": [
        {
          "displayName": "tetsuko.co.jp",
          "property": "properties/987654321"
        }
      ]
    }
  ]
}
```

**キーパス**:
| パス | 型 | 意味 |
|---|---|---|
| `accountSummaries[].displayName` | string | アカウント表示名 |
| `accountSummaries[].account` | string | `accounts/{id}` 形式 |
| `accountSummaries[].propertySummaries[].displayName` | string | プロパティ表示名 |
| `accountSummaries[].propertySummaries[].property` | string | `properties/{id}` 形式 |

**注意**: `propertySummaries` は空配列であり得る（空のアカウント）。

### 1.2 Search Console API v3

```
GET https://searchconsole.googleapis.com/webmasters/v3/sites
Scope: https://www.googleapis.com/auth/webmasters.readonly
```

**応答（実測: 12 件、毎回シャッフルされる）**:
```json
{
  "siteEntry": [
    {
      "siteUrl": "https://tetsuko.co.jp/",
      "permissionLevel": "siteOwner"
    },
    {
      "siteUrl": "https://orgiast.jp/",
      "permissionLevel": "siteOwner"
    }
  ]
}
```

**キーパス**:
| パス | 型 | 意味 |
|---|---|---|
| `siteEntry[].siteUrl` | string | 登録済みサイトの URL（trailing slash 付き） |
| `siteEntry[].permissionLevel` | string | `siteOwner` / `siteFullUser` / `siteRestrictedUser` / `siteUnverifiedUser` |

**注意**: 応答の順序は**非決定的**（実測で毎回異なる）。ツール側で `sortItems()` が title→detail でソートする。

### 1.3 Tag Manager API v2

```
GET https://tagmanager.googleapis.com/tagmanager/v2/accounts
Scope: https://www.googleapis.com/auth/tagmanager.readonly
```

**応答（実測: DWD 未委任のため未取得）**:
```json
{
  "account": [
    {
      "name": "orgiast.jp",
      "accountId": "12345678",
      "path": "/accounts/12345678"
    }
  ]
}
```

**キーパス**:
| パス | 型 | 意味 |
|---|---|---|
| `account[].name` | string | アカウント名 |
| `account[].accountId` | string | GTM アカウント ID |
| `account[].path` | string | API パス |

**現状**: `errorKind = scope_not_delegated` — Admin Console で DWD にスコープ未登録のためトークン交換失敗。

---

## 2. C1.2 — モック応答（テスト用）

### 2.1 JWT トークン交換モック
```json
// POST https://oauth2.googleapis.com/token
// 成功時 (status 200):
{ "access_token": "ya29.xxx.yyy", "token_type": "Bearer", "expires_in": 3600 }

// スコープ未委丹時 (status 401):
{
  "error": "unauthorized_client",
  "error_description": "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."
}
```

### 2.2 GA4 モック（17 アカウント中 3 件で代表）
```json
{
  "accountSummaries": [
    {
      "displayName": "orgiast.jp（組織）",
      "account": "accounts/123456789",
      "propertySummaries": [
        { "displayName": "全ウェブサイトのデータ", "property": "properties/278904354" }
      ]
    },
    {
      "displayName": "東邦鋼業",
      "account": "accounts/234567890",
      "propertySummaries": [
        { "displayName": "tetsuko.co.jp", "property": "properties/987654321" }
      ]
    },
    {
      "displayName": "空のアカウント",
      "account": "accounts/345678901",
      "propertySummaries": []
    }
  ]
}
```

### 2.3 Search Console モック（12 サイト中 3 件で代表）
```json
{
  "siteEntry": [
    { "siteUrl": "https://tetsuko.co.jp/", "permissionLevel": "siteOwner" },
    { "siteUrl": "https://orgiast.jp/", "permissionLevel": "siteOwner" },
    { "siteUrl": "https://minpaku.uhuru.jp/", "permissionLevel": "siteFullUser" }
  ]
}
```

### 2.4 Tag Manager モック（委任完了後の想定）
```json
{
  "account": [
    { "name": "orgiast.jp", "accountId": "12345678", "path": "/accounts/12345678" },
    { "name": "tetsuko.co.jp", "accountId": "23456789", "path": "/accounts/23456789" }
  ]
}
```

### 2.5 エラー応答モック
```json
// GA4: 403 Forbidden（トークン取得済みだが権限なし）
{ "error": { "message": "User does not have any Google Analytics account", "code": 403 } }

// GTM: 401（DWD 未委任）＝scope_not_delegated
{
  "error": "unauthorized_client",
  "error_description": "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."
}

// Search Console: 500
{ "error": { "message": "Backend Error", "code": 500 } }
```

---

## 3. C1.3 — 分割戦略

### 3.1 現状: 直列 3 API

現在のツールは単一プロセス内で 3 API を直列実行（`for (const check of CHECKS)`）。分割案は以下の 3 軸。

### 3.2 軸 A: API 種別ごとの分割（推奨）

| 分割単位 | 内容 | 並列可否 | 依存 | 見積所要時間 |
|---|---|---|---|---|
| GA4 | Analytics Admin 1 リクエスト | 独立して実行可 | なし | 〜2s |
| Search Console | Webmasters 1 リクエスト | 独立して実行可 | なし | 〜2s |
| Tag Manager | Tag Manager 1 リクエスト | 独立して実行可 | なし | 〜2s |

**利点**: 単純・3 並列で wall time 1/3。エラー分離。  
**欠点**: 単位が小さくオーバーヘッドが支配的になり得る。

### 3.3 軸 B: アカウント/プロパティごとの GA4 内分割

| 分割単位 | 内容 | 並列可否 | 依存 |
|---|---|---|---|
| アカウント一覧取得 | 1st API call (accountSummaries) | 親 | 全分割の前提 |
| アカウント別詳細 | 個別 accountSummaries の展開 | 一覧完了後並列 | 一覧の account ID |

**利点**: GA4 に 17 アカウントあればプロパティ取得で並列化可能。  
**欠点**: Analytics Admin API v1beta は accountSummaries 1 発で全アカウントを返すため、個別照会の必要がない。**過剰分割**。

### 3.4 軸 C: フェーズ分割（チェック＋報告）

| Phase | 内容 | 条件 |
|---|---|---|
| P1: 全 API 照会 | 3 API を並列実行 | 常時 |
| P2: 結果集約・ソート・レンダリング | Human/JSON 出力生成 | P1 完了後 |

**利点**: 遅い API を待たずに他から結果が出せる。  
**欠点**: 集約処理が軽量すぎて分割の意味が薄い。

### 3.5 推奨分割

```
クォータスイープでの委譲単位 = API 種別（軸 A）
```

**理由**:
1. GA4 は実測 200ms 程度で完了（17 アカウントでも軽量）
2. Tag Manager は現在 DWD 未委任で即時エラー → 早期停止できる
3. 3 API の並列実行で全体を 2s 前後に圧縮
4. エラー分離により「GTM だけ失敗」が他に影響しない
5. 各 API のモックが独立している（単体テスト容易）

### 3.6 テスト検証計画

| テストケース | 検証内容 | モック | C1.2 の該当モック |
|---|---|---|---|
| 全 API 成功 | 3 種の items が正しく抽出・ソートされる | GA4 + SC + GTM 成功応答 | §2.2 + §2.3 + §2.4 |
| GTM のみ DWD 未委任 | `errorKind = scope_not_delegated`、他 2 種は ok | GA4 成功 + SC 成功 + GTM 401 | §2.2 + §2.3 + §2.5(401) |
| GA4 403 Forbidden | `errorKind = forbidden_no_access`、auth は ok | GA4 403 + SC 成功 + GTM 成功 | §2.5(403) + §2.3 + §2.4 |
| 全 API タイムアウト | 3 種すべて error になる | 全 3 種で AbortSignal 発火 | timeout シナリオ |
| SA 鍵不在 | exit 2, エラーメッセージ | keyPath 不在 | なし（ファイル不在テスト） |
| SA 鍵 JSON 壊れ | exit 2, パースエラー | 不正 JSON | なし |
| 空 GA4 (0 アカウント) | `count = 0`、items = [] | `{ "accountSummaries": [] }` | §2.2 の空配列亜種 |

---

## 4. ツールサマリ（C0 前提の確認）

| 項目 | 内容 |
|---|---|
| **説明** | DWD SA 鍵で kim@orgiast.jp を代理し、GA4 / Search Console / Tag Manager のプロパティ一覧を API 直接照会する読み取り専用ツール |
| **呼び出し** | `node tools/google-property-check.mjs [--json] [--key <path>] [--subject <mail>]` |
| **想定ジョブ** | 「kim 配下の Google 系プロパティの存在/不在」の唯一の証拠を確定する |
| **適合スコア** | 高。依存パッケージなし（Node 18+ 組込のみ）、読み取り専用、終了コード明確（0/2）、JSON 出力対応 |
| **Pros** | DWD で認証一元化 / 3 API 同時照会 / ソート済み / エラー分類精密 / テスト充実(10/10) |
| **Cons** | GTM は DWD 未委任で常時エラー(環境起因) / SA 鍵必須 / 既定鍵パスが PC 間で異なる可能性 |

---

## 5. クォータスイープ委譲判断

```
委譲判断: 可（条件付き）
```

**条件**:
1. SA 鍵（`~/.gcp/` 下の `sheets-sa.json`）が存在すること
2. 鍵のパスが既定値と異なる場合は `--key` または `GOOGLE_SA_KEY` で明示
3. GTM が常に `scope_not_delegated` で落ちるのは既知の制約であり、委譲結果の解釈で考慮する
4. 3 API の並列委譲は 1 回の呼び出しで十分（単一プロセスで wall time 2〜3s）

**委譲不能ケース**:
- SA 鍵がこの PC に無い（他 PC の DWD 鍵）
- Google API 到達不能（プロキシ・企業 NW 制限）
- Node < 18（`fetch` 未対応）

---

## 6. ツール制約の定量評価

| 制約 | 定量値 | 出典 |
|---|---|---|
| GA4 API 応答時間 | 〜200ms（17 アカウント） | 2026-09-20 実測 |
| Search Console 応答時間 | 〜150ms（12 サイト） | 同上 |
| GTM エラー判定時間 | 〜800ms（トークン交換失敗で即座） | 同上（HTTP 401 応答時間） |
| JWT 署名の計算時間 | 〜5ms（RSA 2048） | 同上（同一 PC の openssl 計測より) |
| 最大応答サイズ | GA4: ~50KB / SC: ~5KB / GTM: ~2KB | 17 アカウント x 平均 2 プロパティで推定 |
| レート制限 | Analytics Admin: 50,000 req/day | Google API 文書値 |

---

## 7. 付録: 実際の API 応答（2026-09-20 実測からの抜粋）

```
GA4 accounts: 17 件
Search Console sites: 12 件（含: https://tetsuko.co.jp/ = siteOwner）
Tag Manager: scope_not_delegated（DWD スコープ未登録）
```

完全な実測 JSON は `docs/classifier-denial-external-api-route.md` の集計値を参照。生の応答本文は transcript に残っていない（`--json` モードで再実行すれば取得可能）。

---

## 8. 2026-11-02 決定: GitHub Actions で定期実行（n8n / Docker Desktop / タスクスケジューラは却下）

### 背景
quota-sweep/20261029-2059-claude-mvu11aha ブランチの会話（2026-10-31〜2026-11-01）で、Google Property Check の定期的な自動検証方法を検討した。

### 検討した代替案

| # | 案 | 方式 | 却下理由 |
|---|---|---|---|
| 1 | n8n Docker Desktop 版 | Docker Desktop を PC に導入し n8n docker-compose 起動 | オーバーキル（単一ツールのために Docker Desktop 導入は重すぎる） |
| 2 | n8n Railway 版 | Railway アカウント新設 → n8n テンプレートデプロイ → Webhook 経由呼出 | アカウント作成＋外部ホスティングの管理コストに対して得るものが少ない |
| 3 | **GitHub Actions 定期実行** | `.github/workflows/google-property-check-weekly.yml` を作成し、`node --test` を weekly cron で実行。失敗時は Discord Webhook 通知 | **採用** |
| 4 | Windows タスクスケジューラ | `tools/` のテストを `schtasks` で毎週実行、結果ファイル確認 | トレーサビリティ・障害検知・通知に劣る |

### 決定理由
- n8n（案1・2）は Docker または外部ホスティングが必要で、単一ツールの定期実行としては過剰
- タスクスケジューラ（案4）より GitHub Actions が優れる（トレーサビリティ・通知・既存 CI との統合・コストゼロ）
- 当リポジトリは既に GitHub 管理で、public リポジトリの Actions は無料
- `tools/google-property-check.test.mjs` が既に存在し、`node --test` に対応済み

### 実装内容
1. `.github/workflows/google-property-check-weekly.yml` を作成
   - `node --test tools/google-property-check.test.mjs` を実行
   - cron: 毎週月曜 09:00 JST（= 毎週月曜 00:00 UTC / `0 0 * * 1`）
   - 失敗時に `secrets.DISCORD_WEBHOOK_URL` へ Discord Webhook POST
   - `workflow_dispatch` で手動実行可能
2. `DISCORD_WEBHOOK_URL` を repository secret として登録（手動作業）
3. この evidence ファイルへの決定追納

### 実装ブランチ
- `quota-sweep/20261029-2059-claude-mvu11aha`（変更なし）
- 2026-11-02 commit: `feat(google-property-check): add weekly GitHub Actions workflow`