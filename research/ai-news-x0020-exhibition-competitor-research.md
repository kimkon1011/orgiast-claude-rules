# AIニュース提案 [X-0020]: コーディングエージェントで類似企業サイト調査

## 目的
株式会社オージャストの展示会ブース事業（Re:ブース）において、競合サイトをAI調査し、自社サイトSEO/コンテンツの参考にする。

---

## Step 1: ベストフィットアカウントのドメイン（3〜5個）

### 選定基準
オージャストと比較可能な規模・サービス内容の展示会ブース制作企業を選定。SEO/コンテンツマーケティングの参考にする観点で、特に以下の軸で評価:
- 中小〜中堅規模（資本金・従業員数）
- 展示会ブース施工が主力
- Webでの情報発信・SEO対策が充実しているか

### 選定ドメイン（5件）

| # | 企業名 | ドメイン | 年間売上 | 従業員 | 選定理由 |
|---|--------|---------|---------|-------|---------|
| 1 | **スリービー** | threeb.co.jp | 非公開（中小） | 約20名 | 最も規模が近い。SEO記事「展示会ブース制作会社おすすめ23選」などコンテンツマーケティングに強い。料金表を明確に公開 |
| 2 | **トーガシ** | tohgashi.co.jp | 非公開（中堅） | 約100名 | 年間3,000件。事例ページが豊富でSEOも強い。中小企業向けページも充実 |
| 3 | **ボックス・ワン** | box1.co.jp | 25.5億円 | 60名 | 中堅。施工実績(Beautyworld/SPORTEC等)と自社倉庫を訴求。事例ページ構成が参考になる |
| 4 | **フジヤ** | fujiya-net.co.jp | 約202億円 | 380名 | 大規模だが年間15,000件の実績とコンテンツ量が桁違い。SEO・情報設計のベンチマーク |
| 5 | **サクラインターナショナル** | sakurain.co.jp | 約71億円 | 260名 | 海外展示会に強み。事例(CASE STUDY)ページの質が高い。SRDS(再使用システム)はRe:ブースとコンセプト近い |

### （比較用）自社ドメイン

| 企業名 | ドメイン |
|--------|---------|
| オージャスト（公式） | orgiast.jp |
| Re:ブース（特設） | rebooth.co.jp |

---

## Step 2: DiscoLike への追加手順

DiscoLike（https://discolike.com/）は8,700万以上のビジネスサイトをインデックスし、**ドメイン類似検索**（最大10ドメインまで指定）で類似企業を発見できるAPI/MCPツール。

### 前提
- DiscoLike APIキーが必要（https://docs.discolike.com/api/access/ から発行・無料枠あり）
- MCP接続: `claude mcp add --transport http discolike https://api.discolike.com/v1/mcp`

### 実行手順（MCPまたはCLI）

#### MCP（Claude Codeから直接）
```bash
claude mcp add --transport http discolike https://api.discolike.com/v1/mcp
```
その後、以下のクエリを実行:
```
discover-similar-companies(
  domain: ["threeb.co.jp", "tohgashi.co.jp", "box1.co.jp", "fujiya-net.co.jp", "sakurain.co.jp"],
  employee_range: "1,500",
  max_records: 500
)
```

#### Python（ローカル実行・APIキー方式）
```python
# pip install discolike
from discolike import Discolike
from discolike.requests import DiscoverParams

client = Discolike()  # DISCOLIKE_API_KEY 環境変数が必要

# 5ドメインでの類似検索
companies = client.discover(
    DiscoverParams(
        domain=[
            "threeb.co.jp",
            "tohgashi.co.jp",
            "box1.co.jp",
            "fujiya-net.co.jp",
            "sakurain.co.jp"
        ],
        employee_range="1,500",  # 中小〜中堅に絞る
        country="JP",  # 日本企業に限定
        max_records=500,
    )
)
for c in companies:
    print(f"{c.domain}\t{c.name}\t{c.similarity}")
```

#### CLI（直接）
```bash
discolike discover \
  --domain threeb.co.jp \
  --domain tohgashi.co.jp \
  --domain box1.co.jp \
  --domain fujiya-net.co.jp \
  --domain sakurain.co.jp \
  --employee-range 1,500 \
  --country JP \
  --max-records 500 \
  --format json \
  --output similar-companies-20261114.json
```

### 注意点
- まず `count-matching-domains` でヒット件数を事前確認（課金回避）
- 新規レコードのみ課金（過去24h or 30日以内に見たものは無料）
- 最初は100〜500件で様子見
- 出力はJSON/CSVでローカル保存

---

## Step 3: 類似リストのエクスポート

DiscoLikeの検索結果は以下形式でエクスポート可能:
- **JSON**: 全フィールドを含む構造化データ
- **CSV**: スプレッドシートで開ける形式
- **Google Sheets**: 直接連携（DWD経由でAPI結果をシートに書き込み可）

### 推奨エクスポート手順（API）
```bash
# JSON出力
discolike discover ... --format json --output discolike-results-20261114.json

# CSV出力（スプレッドシート開き用）
discolike discover ... --format csv --output discolike-results-20261114.csv
```

### Google Sheets連携
結果をGoogle Sheetsに格納してフィルタ・分析に使う場合:
```python
import json
import gspread
# DWD credentials で認証
# 結果をシートに書き込む
```

---

## Step 4: Clay / コーディングエージェントでのAI資格認定

Clay（https://www.clay.com/）は150以上のデータプロバイダーを連鎖するウォーターフォール型エンリッチメントツール。

### Clay を使う場合（月額$129〜 有料）
1. **リスト準備**: DiscoLikeのCSVをClayにインポート
2. **Sculptor (Lookalike)**: さらに類似企業を追加検索
3. **ウォーターフォールエンリッチ**: 従業員数・売上・業界・テクノロジーを自動取得
4. **Claygentリサーチ**: 各企業の展示会ブース事業の有無・規模をAI判定
5. **スコアリング**: ICPスコアを設定して優先順位付け

### コーディングエージェント（安価）の場合
AIニュース提案の「Lean」方式。低コストLLM(Groq/Gemini Flash/DeepSeek)で各サイトを訪問し、以下を判定:

```python
# 簡易版AI qualification: 各サイトを訪問し展示会ブース関連か判定
# 使用LLM: Gemini Flash (無料枠) or Groq (高速・低コスト)
import asyncio
import aiohttp

async def qualify_company(domain: str) -> dict:
    """1社のサイトをAI判定"""
    # サイトの内容を取得
    async with aiohttp.ClientSession() as session:
        async with session.get(f"https://{domain}") as resp:
            html = await resp.text()
    
    # LLMで判定（低コストモデル）
    prompt = f"""
    以下のWebサイトが展示会ブース制作・イベント施工を事業としているかを判定。
    {html[:3000]}
    JSON形式:
    {{"is_exhibition_company": bool, "confidence": 0-100, "reason": "..."}}
    """
    # → Groq/Gemini Flash API へ送信
    pass

# バッチ処理（10サンプル→数十万件へ拡大可能）
```

---

## Step 5: Lean / Strict 選択

| 方式 | コスト | 精度 | スケール | オージャスト推奨 |
|------|-------|------|---------|---------------|
| **Lean**（低コストLLM） | ほぼ無料〜数百円/1万件 | 70-80% | 数十万件可 | **✅ 推奨**（初期フェーズ） |
| **Strict**（Clay + 人検証） | 月$129〜 + 工数 | 90-95% | 数千件まで | 効果確認後に導入検討 |

Lean方式では **Groq（Llama/Gemma）** または **Gemini Flash** を使用。日本語対応のためGemini Flashが最適。

---

## Step 6: テスト → スケール

### テスト計画（10サンプル）
1. 選定5ドメインに対してDiscoLikeで各社の類似企業を20社ずつ取得（計100社程度）
2. うち10社をランダム抽出
3. Lean方式で各社の展示会ブース事業をAI判定
4. 人手で結果を検証（正解率を測定）
5. 精度が70%以上なら本番スケールへ

### 本番スケール
- 全類似結果（〜500社）にLean方式を実行
- 結果をGoogle Sheetsに格納
- 競合サイトのSEO分析（タイトルタグ・メタディスクリプション・コンテンツ構成）を追加

---

## 競合サイトSEO分析のポイント（参考）

各ドメインから学べるSEO/コンテンツ戦略の観点:

| 観点 | 競合の傾向 | 自社への示唆 |
|------|-----------|------------|
| タイトルタグ | 「展示会ブース制作」「施工」「デザイン」+社名 | 「Re:ブース 展示会ブース制作・施工 オージャスト」 |
| ブログ/コラム | 業界知識・ノウハウ記事多数（SEO流入源） | 展示会出展ノウハウ・事例記事の定期発信 |
| 事例ページ | 業種別・規模別に整理 | 業種フィルタ付き事例一覧の実装 |
| 料金公開 | スリービーなど中小は料金表を明確に公開 | 中小企業向けに価格帯の明示を検討 |
| 実績数 | 「年間○件」をトップページで訴求 | 実績数・対応エリアの明確化 |

---

## 次のアクション（kim判断待ち）

1. **DiscoLike APIキー発行**: https://docs.discolike.com/api/access/ から取得（無料枠あり）
2. **MCP接続設定**: `claude mcp add --transport http discolike https://api.discolike.com/v1/mcp` を実行
3. **10サンプルテスト**: 上記Step 6のテストを実施
4. **結果分析**: 類似企業リストからSEO参考サイトをピックアップ

出力ファイル: `similar-companies-export.json` / `competitor-seo-analysis.md`