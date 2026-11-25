# X-0008 展示会出展者リスト AI リード獲得ワークフロー（ランブック）

## X-0007-exhibitor-leads-v1 への適用状況（2026-11-07 再照合）

今回の元依頼 X-0007 は本稿と X-0009 の5段に対応する。番号が同じ別題材の X-0007 文書は変更しない。以下を今回の実測状態の正本とし、後段に残す旧サンプル・コード・仕様記述は再検証前の参考資料とする。外部サービスの現行仕様・価格を今回確認したものではない。

| 元依頼の段 | 入力 → 保存すべき出力 | 今回の実測状態 | 残件・合格条件 |
|---|---|---|---|
| 1 全件抽出 | 許容対象URL/endpoint → ID・社名・ブース・説明・website・取得元・取得時刻、ページ別取得記録 | 未実行。旧本文のtotalhits=2,716と5社の転記だけでは全件取得を証明しない | 対象選定と取得許容範囲を確認。全ページの総数とユニークID数を照合し、重複・欠落・エラー・欠損を報告 |
| 2 担当者選別 | 企業リスト → 担当候補と役職/発注関与根拠 | 未実行。キー・利用権限・費用上限の有効な証跡なし | 25〜250人を境界含みで判定し最大3人/社。営業・マーケ・展示会担当のブース発注関与根拠を保存。32並列/数分は出典値で今回の実績ではない |
| 3 清掃 | 候補と企業分類・既接触一覧 → 採用/除外/要確認と理由 | ルール例のみ。CRM既接触一覧未確認 | ディストリビューター・協会・メディア・既接触を除外。不明は要確認とし、一覧未取得を未接触としない |
| 4 活動確認 | 担当候補と基準日時 → 直近5投稿の日時・取得状態・フルプロファイル取得判定 | 未実行。Fetchinの有効な応答証跡なし | 基準日時から60日以内の投稿がある場合だけフルプロファイル取得。取得失敗と非活動を分離し、境界をローカルで検証 |
| 5 サイト分析・文案 | 同一企業サイトと活動根拠 → 販売内容・購買層・購入理由・展示会需要のURL/取得日付き分析、日本語文案 | 未実行。下記enrich_and_generateは項目整形のみでサイト取得や文案生成を実装していない | 走査範囲/除外/未取得/停止条件を記録し、部分取得をサイト全体としない。事実と推論を分離し、現状の集客・出展準備を尋ねブース制作/見積相談へつなぐ1社分を保存 |

対象展示会は未選定。PACK EXPO は旧コードの参考値であり、今回の本番対象として採用しない。既存索引・引継ぎ・同題材文書の限定探索では、対象選定の承認や取得範囲を裏付ける記録を確認できなかった。これはリポジトリ全域での不存在証明ではない。今回許容された作業はユーザーの手動起動指示とローカル契約に基づくリポ内実装・ローカル処理・検証であり、有料サービス、個人データ外部送信、CRM更新、メール/DM送信の許可は得ていない。X-0009の承認先・申請手順は現存する権限の証明として流用しない。

旧コードは短いページや空ページで終了しても総件数との不一致を拒否せず、重複IDの検査、取得元/時刻の保存もない。website取得の例外も空欄にまとめるため、現状では全件抽出の受入に使用できない。Grok生成の来歴を裏付ける応答記録も未確認。次は外部通信のない保存済みページ入力から抽出処理を分離し、部分取得・重複・欠損を識別できる最小実装へ進む。対象承認後に同じ処理を実データへ接続する。


観測日: 2026-11-07。出典: [X 投稿 @mattceras](https://x.com/i/web/status/2118050395389866431)（likes 39、triage verdict=confirmed / adopt=true、category=tool / purpose=business）。
本稿は「株式会社オージャストで試す手順」＝ブース制作営業の見積提案に使う、再現可能な 5 ステップを実測ベースで文書化したもの。

## ワークフロー概要（出典の 5 ステップ）

| # | ステップ | ツール | 本稿での実測状態 |
|---|---|---|---|
| 1 | MapYourShow 隠し JSON から全出展者（名前・ブース・説明・サイト）一括抽出 | Grok 生成 Python スクリプト | 旧主張のみ・今回未実証（上記照合表参照） |
| 2 | Dropleads で企業検索（シニアタイトル・25〜250人・最大3人/社・32並列） | Dropleads | 🔒 要アカウント・API キー（未所持→手順のみ） |
| 3 | ベンダー等を除外してリストクリーン | 自前ルール / LLM 分類 | ⚙️ ルール例を提示 |
| 4 | Fetchin で LinkedIn 過去60日投稿確認 | Fetchin | 🔒 要アカウント（未所持→手順のみ） |
| 5 | サイト全体スクレイプ→販売内容・購入理由分析→メッセージ作成 | Grok 生成 Python + Grok | 手順と項目整形のみ・取得/文案生成は未実装 |

## Step 1: MapYourShow 隠し JSON エンドポイントによる出展者一括抽出（旧参考コード・未再検証）

MapYourShow のショーサイトは Vue SPA で、HTML に展示会データを持たない。隠し AJAX エンドポイント `remote-proxy.cfm` が全データを JSON で返す。

### 旧本文のエンドポイント記述（現行仕様は未確認）

```
GET https://{show}.mapyourshow.com/8_0/ajax/remote-proxy.cfm?action=search&searchtype=exhibitorgallery&searchsize=100&start=0
Headers: X-Requested-With: XMLHttpRequest
```

- 戻り JSON: `SUCCESS` / `DATA.totalhits`（総件数）/ `DATA.results.exhibitor.hit[]`
- 各 hit は `fields` 直下: `exhid_l`（ID）、`exhname_t`（社名）、`exhdesc_t`（説明 HTML）、`boothsdisplay_la`（ブース配列）、`hallid_la`（ホール配列）
- `start` を `searchsize` ずつ進めて全ページ走査する（`start >= totalhits` まで）
- ⚠️ ブース番号は平臺サフィックス `randomstring` が付く（実測: `LL-9003randomstring`・全件）。数値部分だけに正規化する（下記スクリプトで対応）
- プロフィールページ `GET https://{show}.mapyourshow.com/8_0/exhibitor/exhibitor-details.cfm?exhid={id}` の本文から `websiteValue: "..."`（JSON エスケープ `\/` に注意）と `addressValues: { CITY, STATE, COUNTRY, ... }` を正規表現で抽出

### 旧本文の転記サンプル（全件取得の証拠ではない）

```
SUCCESS true totalhits 2716
- 12419945 | 1-Pack, Inc. | LL-9003 | LL | website: https://www.1-pack.us
- 16003621 | 20% Water Savings | LU-7426 | LU
- 12179059 | 3-A Sanitary Standards, Inc. | N-4539 | N
- 02002600 | 3M | N-5720 | N
- 12418770 | 48forty Solutions, LLC | LU-6813 | LU
```

### Grok 生成 Python スクリプト（Step 1+5 共用・CONFIG 差し替えで他ショーに対応）

```python
# exhibitor_lead.py — MapYourShow 出展者抽出 + サイト分析 + メッセージ生成
# Grok (grok-3) 生成を実測データで修正済み。requests/re のみ。
import requests, re, csv, time, html

CONFIG = {
    "show_slug": "packexpo26",          # 他ショーへ差し替え: https://{slug}.mapyourshow.com
    "app_version": "8_0",
    "searchsize": 100,
    "delay_s": 0.5,
    "output_csv": "exhibitors.csv",
}
BASE = f"https://{CONFIG['show_slug']}.mapyourshow.com/{CONFIG['app_version']}"
HEADERS = {"X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def get_all_exhibitors():
    """search エンドポイントを全ページ走査して出展者一覧を返す。"""
    out, start = [], 0
    while True:
        r = requests.get(f"{BASE}/ajax/remote-proxy.cfm", params={
            "action": "search", "searchtype": "exhibitorgallery",
            "searchsize": CONFIG["searchsize"], "start": start}, headers=HEADERS, timeout=20)
        r.raise_for_status()
        j = r.json()
        total = j["DATA"]["totalhits"]
        hits = (j["DATA"].get("results") or {}).get("exhibitor", {}).get("hit", [])
        for h in hits or []:
            f = h.get("fields", {})
            booths = [b.replace("randomstring", "").strip() for b in (f.get("boothsdisplay_la") or [])]
            out.append({
                "exhid_l": f.get("exhid_l", ""),
                "exhname_t": f.get("exhname_t", ""),
                "exhdesc_t": re.sub(r"<[^>]+>", " ", f.get("exhdesc_t", "")).strip(),
                "boothsdisplay_la": ",".join(booths),
                "hallid_la": ",".join(f.get("hallid_la", []) or []),
            })
            out[-1]["website"] = fetch_website(out[-1]["exhid_l"])
            time.sleep(CONFIG["delay_s"])
        print(f"  {len(out)}/{total}", flush=True)
        if not hits or len(hits) < CONFIG["searchsize"] or start + len(hits) >= total:
            break
        start += len(hits)
    return out

def fetch_website(exhid):
    """プロフィールページの websiteValue を抽出。JSON エスケープ \\/ に注意。"""
    try:
        r = requests.get(f"{BASE}/exhibitor/exhibitor-details.cfm", params={"exhid": exhid},
                         headers=HEADERS, timeout=15)
        m = re.search(r'websiteValue:\s*"((?:[^"\\]|\\.)*)"', r.text)
        return m.group(1).replace("\\/", "/") if m else ""
    except Exception:
        return ""

def enrich_and_generate(rows):
    """Web 検索・LLM 分析は別レーン（Grok/DeepSeek）へ。Step 5 の入力を作る。"""
    return [{"company": r["exhname_t"], "booth": r["boothsdisplay_la"], "website": r["website"],
             "about": r["exhdesc_t"][:500], "why_purchase_candidate": True} for r in rows]

if __name__ == "__main__":
    rows = get_all_exhibitors()
    with open(CONFIG["output_csv"], "w", newline="", encoding="utf-8-sig") as fp:
        w = csv.writer(fp)
        w.writerow(["exhid_l", "exhname_t", "exhdesc_t", "boothsdisplay_la", "hallid_la", "website"])
        for r in rows:
            w.writerow([r["exhid_l"], r["exhname_t"], r["exhdesc_t"], r["boothsdisplay_la"], r["hallid_la"], r["website"]])
    print(f"done: {len(rows)} rows -> {CONFIG['output_csv']}")
```

実行: `python exhibitor_lead.py`（Python 3.8+、`pip install requests`）。プロキシ環境では環境変数の設定を確認。

## Step 2: Dropleads での企業検索（要アカウント・手順）

- 対象: Step 1 の全社名を一括投入。API キー取得後に 32 並列ルックアップで数分（出典数値）。
- フィルター: シニアタイトル（CEO/VP/Marketing 等）、従業員 25〜250 人、1 社最大 3 人。
- 未実測理由: Dropleads アカウント・API キーをこの環境に未所持。キー取得後に `node tools/grok-ask.mjs` 用の同型ラッパー（fetch ベース）で実行する。

## Step 3: ベンダー等の除外（リストクリーン）

除外ルール例（業界により調整）:
- 社名に `Association|Media|Consulting|Agency|Exhibit|Booth|Show Management|Bank|Insurance|Logistics` 等のベンダー語
- `exhdesc_t` に「私たちは展示会を提供/運営する」等の主催・運営・メディア記述
- 同業他社（ブース制作・イベント企画）を除外
- LLM 分類（DeepSeek/Groq、`--kind classify`）で 1000 件単位の高速判定も可

## Step 4: Fetchin で LinkedIn 投稿確認（要アカウント・手順）

- 各候補企業の LinkedIn を過去 60 日に絞って活動確認（採用・展示会・新製品の投稿があればウォームアプローチ材料）。
- 未実測理由: Fetchin アカウントを未所持。

## Step 5: サイトスクレイプ→販売内容・購入理由分析→メッセージ生成

1. Step 1 の `website` 列に対し Python（requests+re）で `robots.txt` 対応しつつトップ〜主要ページを取得。
2. テキスト化後に Grok (`node tools/grok-ask.mjs "要約とアプローチ文を生成"`) へ渡す。プロンプト例:

```
この企業のサイト文章を分析し、(1)販売しているもの (2)顧客が買う理由/課題 (3)
ブース制作・展示会出展支援の提案で刺さる1文を日本語で3案。企業: {company} / 概要: {about}
```

3. 生成文は見積提案の冒頭パーソナライズに使用。1社1文 + 共通本文の組合せで量産。

## 株式会社オージャストでの適用フロー

1. 参加・出展する展示会が MapYourShow 平台なら Step 1 をそのまま実行（`CONFIG.show_slug` 差し替えのみ）。非対応平台は出展者一覧を CSV で入手して同等処理。
2. Step 2〜4 の有料アカウント（Dropleads / Fetchin）は月契約のため、初期は LinkedIn 手動確認 + Grok 生成文で代替し、効果を1展示会分で測ってから契約判断。
3. 見込み客リスト（Google スプレッドシート）: 企業名 / ブース / 概要 / website / 担当候補 / アプローチ文。これをブース制作の見積提案に使用。
4. 費用目安: Step 1+5 は既存 Grok/DeepSeek キー利用で追加費用ほぼゼロ。Dropleads / Fetchin は双方 100 ドル/月級（要出典・要比較）→ 契約前に2案比較表を kim へ。

## 検証・限界

- 旧本文はpackexpo26で実測済みと記載していたが、今回有効な取得ログ・全件照合・対象承認は未確認。上記照合表に従い未実証として扱う。
- サイトは show ごとにデプロイ構成が異なり得る。`8_0` 以外の app_version や別平台はエンドポイントを再調査する。
- Step 2/4 はキー・アカウント未所持のため手順のみ（未実測）。実行後に実データで本稿を更新する。
- スクレイピングはサーバー負荷を考慮し delay を入れ、robots.txt / 利用規約を確認して行う。
## X-0007 保存ページのローカル抽出（2026-11-07）

`node tools/exhibitor-pages.mjs capture.json report.json` は外部通信せず、正規化した保存ページを検査する。ローカル実装でありGrok生成やMap Your Showへの接続実績ではない。個別サービスの応答からこの形式への変換と、取得対象・総件数の一次資料照合は未実装。

入力例（模擬データ。取得の証拠ではない）:

```json
{"total":1,"pages":[{"offset":0,"total":1,"source":"https://example.com/exhibitors","fetchedAt":"2026-11-07T00:00:00Z","rows":[{"id":"demo-1","company":"模擬企業","booth":"A1","description":"模擬説明","website":"https://example.com"}]}]}
```

各ページに0始まりoffset、同一total、取得元source、タイムゾーン付きfetchedAt、rowsが必要。取得失敗はerrorに保存する。各行は文字列のid/company/booth/description/websiteを持つ。出力は正規化行、ユニークID数、欠落・重複・取得エラー・欠損のissuesを含む。正常終了0、不完全1、入力不正等2。欠損があっても行を保持し、complete=falseとする。空ページ配列は全件取得としない。completeは渡された保存入力の整合性だけを示し、実対象へのアクセス許可、提供者の総件数の正しさ、実取得、サイト全体の分析を証明しない。連絡先や秘密をこの入力や一般ログへ含めない。

### X-0007: 担当者のローカル選別（実サービス未接続）

`node tools/exhibitor-contacts.mjs input.json output.json` は正規化済み証跡を選別する。
入力は `referenceAt`（タイムゾーン付き基準日時）と `contacts` 配列。
各担当者は `id`, `companyId`, 整数 `employees`, `companyType`（manufacturer/distributor/association/media）、
`crmStatus`（contacted/uncontacted）, `crmEvidence`, `roleEvidence`, `boothEvidence`,
`postsStatus`（ok/失敗状態）と直近5件の `posts`（publishedAt/source）を持つ。
各Evidenceは、実利用では元応答・取得日時・根拠URLを追跡できる保存証跡への参照とする。
役職文字列だけで発注権限を推定せず、営業・マーケ・展示会担当の役割とブース関与を人が確認して入力する。
入力の証跡の真偽、投稿が実際に直近5件か、CRM一覧の網羅性はこの処理では検証できない。

25〜250人は境界を含む。60日前ちょうどの投稿は活動ありとする。
不明証跡・取得失敗はreview、非活動や既接触などはexcludedと理由を出力する。
同じ担当者IDは重複除外し、入力順に1社最大3人までeligibleにする。
`fetchFullProfile` はローカルの次段候補フラグであり、API呼出や費用権限を与えるものではない。
連絡先生データはGitへ保存せず、入力・出力は `.loop/` 等のローカル領域へ置く。
フィクスチャの合格はC3実サービス応答の証明ではなく、外部接続と実証は未達のまま。

### Step 5 限定実データ試験（2026-11-07）

[1-Packの公開サイト分析・日本語文案](ai-news-x0008-1pack-site-draft.md)を保存した。公式本文4ページの人手参照であり、サイト全体取得ではない。robots/取得許容範囲は未確認、流通機能により清掃対象の適合も要確認。現在の出展予定・担当者・CRMは未確認のため、本番対象採用やC4全条件の達成には数えない。

### 投稿証跡の重複防止（試行006）

`posts` は異なる投稿の取得元を5件記録する。同一の `source`（前後空白を除去して比較）の反復、空白だけ、文字列以外は `invalid-five-posts` として要確認へ戻し、フルプロファイル取得を許可しない。URL別名で同一投稿を表す場合の同一性や、実際の直近5件であることは上流の実応答照合が必要。ローカル模擬試験の合格は実担当者の活動確認ではない。

CRM・役職・ブース担当の根拠（`crmEvidence` / `roleEvidence` / `boothEvidence`）は空白以外を含む文字列を必須とする。空白だけ、数値、真偽値、配列、オブジェクトは要確認へ戻し、フルプロファイル取得を許可しない。文字列の内容の真偽や取得権限は別途確認が必要。

### 抽出と選別を接続する引継ぎ手順（試行008、模擬実行）

抽出の `rows[].id` と担当者の `companyId` を同じ出展企業IDへ正規化してから接続する。企業名の類似だけで接続しない。選別CLI単独では出展企業への所属を検査しないため、`eligible` でも抽出結果に存在しない企業は隔離する。抽出が不完全なら後段へ進めず、`review` は営業文案の対象へ採用しない。

ローカルの正規化済み入力を用意し、次の順番で実行する。入力は模擬と実測を分け、秘密・連絡先の生データをGitへ保存しない。

```sh
node tools/exhibitor-pages.mjs capture.json report.json
# 終了0とcomplete=trueを確認してから次へ進む
node tools/exhibitor-contacts.mjs contacts.json selected.json
# 次の照合でmatchedとquarantinedを分ける
python3 - <<'PY'
import json
from pathlib import Path
report = json.loads(Path('report.json').read_text())
if report['complete'] is not True:
    raise SystemExit('不完全な抽出: 後段停止')
selected = json.loads(Path('selected.json').read_text())
ids = {row['id'] for row in report['rows']}
joined = {
    'matched': [row for row in selected if row['companyId'] in ids],
    'quarantined': [row for row in selected if row['companyId'] not in ids],
}
Path('joined.json').write_text(json.dumps(joined, ensure_ascii=False, indent=2))
PY
```

今回の模擬実行では、1社の抽出に対して同一企業のeligible1件とCRM不明のreview1件を接続し、対象外企業のeligible1件を隔離した。固定期待値との照合は成功。これは保存入力同士の接続検査であり、提供者の実応答やCRM網羅性は証明しない。照合コードは手順例であり、専用の統合CLIは未実装。

文案へ進めるには、matchedのeligibleと同じ企業IDについて、取得を許容されたサイトの根拠URL・取得日・走査範囲・除外・未取得を紐付ける。販売内容・購買層・購入理由の事実と、ブース需要の推論を分離する。現状の集客・出展準備を質問し、ブース制作や見積相談へつなぐ。既存1-Pack文案は同じ模擬企業の根拠として流用できない。

実証再開に必要なのは、対象展示会と取得許容範囲の根拠、総件数に照合できる全ページの実応答、同じ企業IDの担当者・従業員・役職/ブース関与証跡、網羅性を確認したCRM照合、日時付き直近5投稿、適格企業のサイト取得証跡である。未提供の間は実全件取得・未接触・活動確認・適格企業文案の成功を主張しない。累積8回の上限に到達したため、この契約の新規作業は停止する。
