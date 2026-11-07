# X-0008 展示会出展者リスト AI リード獲得ワークフロー（ランブック）

観測日: 2026-11-07。出典: [X 投稿 @mattceras](https://x.com/i/web/status/2118050395389866431)（likes 39、triage verdict=confirmed / adopt=true、category=tool / purpose=business）。
本稿は「株式会社オージャストで試す手順」＝ブース制作営業の見積提案に使う、再現可能な 5 ステップを実測ベースで文書化したもの。

## ワークフロー概要（出典の 5 ステップ）

| # | ステップ | ツール | 本稿での実測状態 |
|---|---|---|---|
| 1 | MapYourShow 隠し JSON から全出展者（名前・ブース・説明・サイト）一括抽出 | Grok 生成 Python スクリプト | ✅ 本番エンドポイントで動作確認（packexpo26・totalhits=2,716） |
| 2 | Dropleads で企業検索（シニアタイトル・25〜250人・最大3人/社・32並列） | Dropleads | 🔒 要アカウント・API キー（未所持→手順のみ） |
| 3 | ベンダー等を除外してリストクリーン | 自前ルール / LLM 分類 | ⚙️ ルール例を提示 |
| 4 | Fetchin で LinkedIn 過去60日投稿確認 | Fetchin | 🔒 要アカウント（未所持→手順のみ） |
| 5 | サイト全体スクレイプ→販売内容・購入理由分析→メッセージ作成 | Grok 生成 Python + Grok | ⚙️ フロー実装済み（実行は対象サイト確認後） |

## Step 1: MapYourShow 隠し JSON エンドポイントによる出展者一括抽出（実測済み）

MapYourShow のショーサイトは Vue SPA で、HTML に展示会データを持たない。隠し AJAX エンドポイント `remote-proxy.cfm` が全データを JSON で返す。

### エンドポイント仕様（2026-11-07 実測）

```
GET https://{show}.mapyourshow.com/8_0/ajax/remote-proxy.cfm?action=search&searchtype=exhibitorgallery&searchsize=100&start=0
Headers: X-Requested-With: XMLHttpRequest
```

- 戻り JSON: `SUCCESS` / `DATA.totalhits`（総件数）/ `DATA.results.exhibitor.hit[]`
- 各 hit は `fields` 直下: `exhid_l`（ID）、`exhname_t`（社名）、`exhdesc_t`（説明 HTML）、`boothsdisplay_la`（ブース配列）、`hallid_la`（ホール配列）
- `start` を `searchsize` ずつ進めて全ページ走査する（`start >= totalhits` まで）
- ⚠️ ブース番号は平臺サフィックス `randomstring` が付く（実測: `LL-9003randomstring`・全件）。数値部分だけに正規化する（下記スクリプトで対応）
- プロフィールページ `GET https://{show}.mapyourshow.com/8_0/exhibitor/exhibitor-details.cfm?exhid={id}` の本文から `websiteValue: "..."`（JSON エスケープ `\/` に注意）と `addressValues: { CITY, STATE, COUNTRY, ... }` を正規表現で抽出

### 実測サンプル（packexpo26 = PACK EXPO International 2026）

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

- Step 1 は本番エンドポイント（packexpo26）で実測済み（totalhits=2,716、社名/ブース/ホール/サイト抽出）。
- サイトは show ごとにデプロイ構成が異なり得る。`8_0` 以外の app_version や別平台はエンドポイントを再調査する。
- Step 2/4 はキー・アカウント未所持のため手順のみ（未実測）。実行後に実データで本稿を更新する。
- スクレイピングはサーバー負荷を考慮し delay を入れ、robots.txt / 利用規約を確認して行う。