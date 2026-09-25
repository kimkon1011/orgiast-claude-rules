<!-- このファイルは tools/ai-tool-market-map.mjs --write が生成する。手で編集しない。 -->

# AIツール市況マップ（商用/趣味レベル）

AIニュース提案 P-0153: AIツールの商用/趣味レベル実態調査。世の中に出ているAIツールをカテゴリ別に、機能・価格帯・商用利用の可否でマッピングする。

調査日: 2026-09-26

価格は 2026-09 時点の公開情報。為替・値改定・地域差で変動するため、契約直前に各社公式の価格ページで確認する。円換算は 1USD=150JPY の目安。

## 調査方法

WebSearch による二次情報の突き合わせ。価格は複数ソースで一致した範囲を priceBand として記録し、単一ソースのみ／ソース間で食い違う場合は confidence を low に落とした。断定できない値は null のまま残す（推測で埋めない）。

## レベル定義

| レベル | 定義 |
| --- | --- |
| hobby | 趣味・個人。無料〜月20USD未満。商用利用が不可／条件付きのことが多く、入力が学習に使われる場合がある。 |
| prosumer | 副業・小規模商用。月20〜100USD。商用利用ライセンスが付き始める帯。 |
| business | 法人・チーム。月100USD以上または席課金。学習オプトアウト・権限管理・IP補償が付く帯。 |

## 商用利用の区分

| 区分 | 説明 |
| --- | --- |
| allowed | 商用利用可（有料プランで明示的に許諾） |
| restricted | 条件付き（用途・プラン・クレジット種別で制限。例: 配信不可、ウォーターマーク有、生成物が既定公開） |
| not-allowed | 商用利用不可（無料プランは非商用のみ等） |
| varies | ソース間で見解が割れている／プランにより異なる |

## 市況の全体像

| metric | value | source |
| --- | --- | --- |
| 724ツール中 freemium の割合 | 53%（386件） | [https://toolchase.com/state-of-ai-tools-2026/](<https://toolchase.com/state-of-ai-tools-2026/>) |
| 完全無料のツール | 6%（44件） | [https://toolchase.com/state-of-ai-tools-2026/](<https://toolchase.com/state-of-ai-tools-2026/>) |
| 何らかの無料アクセスを提供 | 59% | [https://toolchase.com/state-of-ai-tools-2026/](<https://toolchase.com/state-of-ai-tools-2026/>) |
| 主要アシスタントの標準月額 | 20USD。10USD未満のライト層（ChatGPT Go 8USD / Gemini Plus 4.99USD）が出現 | [https://toolchase.com/state-of-ai-tools-2026/](<https://toolchase.com/state-of-ai-tools-2026/>) |

## カテゴリ別マッピング

### 汎用チャット・推論

役割: 社内の下書き・要約・翻訳・壁打ちの土台。ここが最も「無料で足りる」ため、趣味とビジネスの差が最も出にくいカテゴリ。

ビジネス移行の条件: 入力データを学習に使わせない契約（Team/Enterprise）と SSO・権限管理が要る時点でビジネス帯に上がる。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | OpenAI | $0〜$200 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Claude | Anthropic | $0〜$200 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Google Gemini | Google | $0〜$200 | 席課金（1ユーザーあたり月額） | ソース間で見解が割れている／プランにより異なる | medium |

#### ChatGPT

- **Free**: $0/月
- **Go**: $8/月
- **Plus**: $20/月
- **Pro**: $100/月
- **Business**: $20/月 — 年払い/席。月払いは25USD/席。2席から

- 趣味レベル: 無料でもテキストチャットの回数制限は2026年8月に撤廃。ただし入力が学習に使われ得る。
- ビジネスレベル: Business 以上で既定で学習に使わない。Pro は上位モデルと高枠。

出典: [https://chatgpt.com/ja-JP/pricing](<https://chatgpt.com/ja-JP/pricing>) / [https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/](<https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/>)

#### Claude

- **Free**: $0/月
- **Pro**: $20/月 — 年払い17USD
- **Max 5x**: $100/月
- **Max 20x**: $200/月
- **Team Standard**: $25/月 — 年払い20USD/席。5席から（2席とするソースもあり）
- **Team Premium**: $125/月 — 年払い100USD/席。Claude Code を含む

- 趣味レベル: 長文処理は無料範囲でも強い。5時間あたりの利用上限あり（2026-05-06 に倍増）。
- ビジネスレベル: Team 以上で管理者控制・SSO・学習オプトアウト。Claude Code を使うなら Team Premium 以上。

出典: [https://benchlm.ai/claude/pricing-plans](<https://benchlm.ai/claude/pricing-plans>) / [https://www.spendhound.com/blog/claude-pricing-negotiation-guide](<https://www.spendhound.com/blog/claude-pricing-negotiation-guide>)

#### Google Gemini

- **Free**: $0/月
- **AI Plus**: $7.99/月 — 日本円 1,200円/月
- **AI Pro**: $19.99/月 — 日本円 2,900円/月。5TB・YouTube Premium Lite 付帯
- **AI Ultra 5x**: $99.99/月 — 日本円 14,500円/月。月払いのみ
- **AI Ultra 20x**: $200/月 — 日本円 32,000円/月。旧250USDから値下げ

- 趣味レベル: 無料でも高速モデルにアクセス可。無料の画像生成はウォーターマーク付き・1日約20枚。
- ビジネスレベル: Workspace 契約とは別建て。日本は円建てプランに移行済みで、ドル建てより為替リスクが小さい。

出典: [https://pc.watch.impress.co.jp/docs/news/2110129.html](<https://pc.watch.impress.co.jp/docs/news/2110129.html>) / [https://mashable.com/article/google-io-2026-gemini-ultra-ai-subscription-tiers](<https://mashable.com/article/google-io-2026-gemini-ultra-ai-subscription-tiers>)

### コーディングエージェント

役割: 実装の自動化。単価が最も高く、かつ「定額サブスク vs API従量」の損益分岐がはっきりしているカテゴリ。

ビジネス移行の条件: 複数人で同じ枠を共有する／社外に出せないコードを扱う／監査ログが要る時点でビジネス帯。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| GitHub Copilot | GitHub | $0〜$100 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Cursor | Anysphere | $0〜$200 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| GLM Coding Plan | Z.ai (Zhipu) | $10〜$160 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | low |

#### GitHub Copilot

- **Free**: $0/月 — 補完2,000回/月・チャット50回/月
- **Pro**: $10/月
- **Pro+**: $39/月
- **Max**: $100/月
- **Business**: $19/月

- 趣味レベル: Free は補完回数に上限。2026-06-01 から AI credits 課金（1 credit = 0.01USD）に移行。
- ビジネスレベル: 最安の入口。他社エージェント（Claude Code / Codex）を Copilot から動かす経路もある。

出典: [https://openclawlaunch.com/guides/ai-coding-plans-compared](<https://openclawlaunch.com/guides/ai-coding-plans-compared>) / [https://rankllms.com/coding-plans/](<https://rankllms.com/coding-plans/>)

#### Cursor

- **Hobby**: $0/月 — プレミアムリクエスト50回/月
- **Pro**: $20/月 — フロンティアモデル枠 20USD 込み
- **Ultra**: $200/月 — 終日エージェント運用向け

- 趣味レベル: Free はプレミアムリクエスト50回/月。タブ補完は無制限。
- ビジネスレベル: IDE 型。API キーを検出できないため社内の利用実態把握は契約台帳側で行う必要がある。

出典: [https://www.aimadetools.com/blog/how-to-choose-ai-coding-agent-2026](<https://www.aimadetools.com/blog/how-to-choose-ai-coding-agent-2026>) / [https://andrew.ooo/answers/cheapest-ai-coding-subscription-2026-glm-copilot-claude-cursor/](<https://andrew.ooo/answers/cheapest-ai-coding-subscription-2026-glm-copilot-claude-cursor/>)

#### GLM Coding Plan

- **Lite (海外)**: $18/月 — 2026-02 に約10USD、2026-04 に18USDへ二段階値上げ。年払い12.6USD
- **Pro (海外)**: $72/月
- **Max (海外)**: $160/月
- **中国国内 Lite**: $7/月 — 約20元。海外版と同一枠で2倍以上の差

- 趣味レベル: Lite でも Claude Code / Cline / Codex 等 20以上のツールから使える。ピーク時間はポイント2倍消費。
- ビジネスレベル: 2026年に2度値上げしており年間契約は非推奨とする記事が多い。データ所在地が中国である点は要確認。

出典: [https://www.remio.ai/post/the-glm-coding-plan-went-viral-in-north-america-then-the-price-doubled](<https://www.remio.ai/post/the-glm-coding-plan-went-viral-in-north-america-then-the-price-doubled>)

### 調査・検索・資料化

役割: 外部情報の収集と一次資料の読み込み。無料枠が最も実用的なカテゴリで、趣味レベルでも業務品質に届く。

ビジネス移行の条件: 社内文書を大量に読み込ませる／出典の監査が要る時点でビジネス帯。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Perplexity | Perplexity AI | $0〜$20 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Genspark | Genspark | $24.99〜$249.99 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| NotebookLM | Google | $0〜$19.99 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | low |

#### Perplexity

- **Free**: $0/月 — 基本検索は無制限、Pro検索 約5回/日
- **Pro**: $20/月 — Pro検索 約300回/日、ファイル投入・画像生成

- 趣味レベル: 無料でも出典付き検索が無制限。日常の調査はここで足りる。
- ビジネスレベル: 円建て未対応（USD建て）。出典URLが残るため根拠提示に向く。

出典: [https://aiagentsquare.com/category/research-ai-agents](<https://aiagentsquare.com/category/research-ai-agents>) / [https://eyalmarcus.com/en/blog/ai-tools-guide-2026/](<https://eyalmarcus.com/en/blog/ai-tools-guide-2026/>)

#### Genspark

- **Plus**: $24.99/月 — 年払い19.99USD
- **Pro**: $249.99/月

- 趣味レベル: 無料枠はあるが、Sparkpage・スライド・シート生成は Plus 以上が実用的。
- ビジネスレベル: 調査結果を成果物の形で出す点が他と違う。社内では既に契約済み（tools/ai-subscription-catalog.json）。

出典: [https://eyalmarcus.com/en/blog/ai-tools-guide-2026/](<https://eyalmarcus.com/en/blog/ai-tools-guide-2026/>) / [https://aiagentsquare.com/category/research-ai-agents](<https://aiagentsquare.com/category/research-ai-agents>)

#### NotebookLM

- **Free**: $0/月 — ノートブック100・ソース50/冊・チャット50回/日・音声概要3回/日
- **Plus (Google AI Plus 経由)**: $7.99/月
- **Plus (Google AI Pro 経由)**: $19.99/月

- 趣味レベル: 単体課金は廃止され Google AI サブスクに同梱。無料枠が「たいていの用途に足りる」と複数ソースが評価。
- ビジネスレベル: 読み込ませた文書だけを根拠にするため、社内文書の要約に向く。

出典: [https://jiangren.com.au/blog/notebooklm-guide-05-faq](<https://jiangren.com.au/blog/notebooklm-guide-05-faq>)

### 資料・スライド作成

役割: 提案書・スライドの初稿生成。単価は安く、趣味と商用の差はほぼ「クレジット数」だけ。

ビジネス移行の条件: PPTX 書き出しや自社テンプレート適用、複数人編集が要る時点でビジネス帯。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Gamma | Gamma | $0〜$90 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |
| Napkin AI | Napkin | $0〜$22 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |

#### Gamma

- **Free**: $0/月 — 登録時400クレジットの買い切り（毎月補充なし）
- **Plus**: $9/月 — 1,000クレジット/月
- **Pro**: $18/月 — 4,000クレジット/月
- **Ultra**: $90/月

- 趣味レベル: 無料枠は買い切りで、再生成やPPTX出力のたびに減るため業務では早期に尽きる。
- ビジネスレベル: 有料プラン前提で考えるのが現実的。デザインより速度のツール。

出典: [https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html](<https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html>)

#### Napkin AI

- **Free**: $0/月 — 週500クレジット（毎週リセット）
- **Plus**: $9/月 — 10,000クレジット/月
- **Pro**: $22/月 — 30,000クレジット/月

- 趣味レベル: 無料枠が毎週戻るため、趣味用途では継続的に使える珍しい型。
- ビジネスレベル: 文章から図解を作る専用機。スライド全体生成の Gamma とは役割が別。

出典: [https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html](<https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html>)

### 画像生成

役割: ブースのパース・資料のビジュアル。ここは「商用利用の可否」が価格以上に重要になるカテゴリ。

ビジネス移行の条件: 広告・提案書など社外に出る成果物に使う時点で、無料プランは全て失格になる。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Midjourney | Midjourney | $10〜$120 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Ideogram | Ideogram | $0〜$42 | クレジット消費型 | 条件付き（用途・プラン・クレジット種別で制限。例: 配信不可、ウォーターマーク有、生成物が既定公開） | low |
| Adobe Firefly | Adobe | $0〜 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |
| FLUX (Black Forest Labs) | Black Forest Labs | 従量/要見積 | 従量課金（API・秒・枚） | ソース間で見解が割れている／プランにより異なる | medium |

#### Midjourney

- **Basic**: $10/月 — 年払い8USD。Fast 3.3時間
- **Standard**: $30/月 — Relax 無制限
- **Pro**: $60/月 — Stealth Mode
- **Mega**: $120/月

- 趣味レベル: 無料プランが存在しない（=趣味でも最低10USD）。
- ビジネスレベル: 年商100万USD超の企業は Pro 以上が要るとされる。法人の利用条件は要確認。

出典: [https://toolradar.com/guides/best-ai-image-generators](<https://toolradar.com/guides/best-ai-image-generators>) / [https://aiweekly.co/learning-ai/ai-applications/best-ai-image-generators](<https://aiweekly.co/learning-ai/ai-applications/best-ai-image-generators>)

#### Ideogram

- **Free**: $0/月 — 約10プロンプト/日
- **Basic**: $8/月
- **Plus**: $15/月
- **Pro**: $42/月

- 趣味レベル: 無料プランは生成物が既定で公開される。文字入れが得意。
- ビジネスレベル: 有料プランは商用可だが、オープンウェイト版(Ideogram 4.0)は非商用のみで、商用自前ホストは別ライセンス。

出典: [https://www.layer3labs.io/comparisons/ideogram-alternatives](<https://www.layer3labs.io/comparisons/ideogram-alternatives>) / [https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1](<https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1>)

#### Adobe Firefly

- **無料枠**: $0/月 — 10クレジットのみ（補充なし）

- 趣味レベル: 無料枠は事実上お試しのみ。
- ビジネスレベル: 商用可かつ法人向けIP補償がある点が他社との決定的な差。法務が絡む案件ではここが安全側。

出典: [https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1](<https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1>)

#### FLUX (Black Forest Labs)

- **FLUX.2 klein 4B**: $0.014/メガピクセル
- **FLUX.2 pro**: $0.03/メガピクセル
- **FLUX.2 max**: $0.07/メガピクセル
- **FLUX.1 schnell (Apache 2.0)**: $0/メガピクセル — 自前ホストで商用可
- **FLUX.2 dev**: $0/メガピクセル — オープンウェイトだが非商用

- 趣味レベル: 月額プランが存在せず、枚数課金のみ。
- ビジネスレベル: モデルごとに商用可否が違う。schnell(Apache 2.0)だけが無料で商用可。dev は非商用なので取り違えると事故になる。

出典: [https://www.layer3labs.io/comparisons/stable-diffusion-alternatives](<https://www.layer3labs.io/comparisons/stable-diffusion-alternatives>)

### 動画生成

役割: ブース提案の動線再現・SNS用の短尺。2026年は無料枠が縮小し、趣味とビジネスの断絶が最も大きいカテゴリ。

ビジネス移行の条件: 社外に出す映像に使う時点で、無料枠はウォーターマークと商用不可の二重で失格。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Kling | Kuaishou | $5.99〜$92 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | low |
| Runway | Runway | $12〜$95 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |
| Sora | OpenAI | $20〜$200 | 席課金（1ユーザーあたり月額） | ソース間で見解が割れている／プランにより異なる | low |
| Wan 2.2 / LTX Video（オープンソース） | Alibaba / Lightricks ほか | 従量/要見積 | 自前ホスト（ソフト本体は無料、インフラ費のみ） | 商用利用可（有料プランで明示的に許諾） | medium |

#### Kling

- **Standard**: $5.99/月 — Kling 2.0 / 660クレジット。3.0 は6.99USD
- **Pro**: $25.99/月
- **Premier**: $92/月 — 1080p〜4K・商用利用

- 趣味レベル: 月6USDで約66本の5秒動画。動画生成としては最安の入口。
- ビジネスレベル: 商用利用の明示が Premier 帯。コスパ最優先の選択肢。

出典: [https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026](<https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026>) / [https://socialsight.ai/blog/best-ai-video-models-2026-costs](<https://socialsight.ai/blog/best-ai-video-models-2026-costs>)

#### Runway

- **Standard**: $15/月 — 年払い12USD。625クレジット
- **Pro**: $35/月 — 年払い28USD。2,250クレジット
- **Unlimited**: $95/月 — 年払い76USD

- 趣味レベル: 無料は125クレジットの使い切り・720p・ウォーターマーク付き。
- ビジネスレベル: クレジットの減りがモデルで5〜25倍違う。Gen-4.5 は毎秒25クレジットで、Standard 枠だと月25秒分しかない。見積は「完成秒数×モデル係数」で行う。

出典: [https://academy.techpresso.co/reviews/is-runway-worth-it](<https://academy.techpresso.co/reviews/is-runway-worth-it>) / [https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026](<https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026>)

#### Sora

- **ChatGPT Plus 経由**: $20/月 — 720p・5〜10秒・ウォーターマーク
- **ChatGPT Pro 経由**: $200/月 — 1080p・ウォーターマーク無し

- 趣味レベル: 単体契約は無く ChatGPT に同梱。
- ビジネスレベル: コンシューマ向けアプリは2026-04-26 に終了との情報があり、提供形態が流動的。導入判断は保留が妥当。

出典: [https://toolindex.net/blog/ai-video-generation-sora-vs-kling-vs-runway-2026](<https://toolindex.net/blog/ai-video-generation-sora-vs-kling-vs-runway-2026>)

#### Wan 2.2 / LTX Video（オープンソース）

- **自前GPU**: 要見積 — Apache 2.0・商用無制限。VRAM 12GB以上（Helios は6GB）

- 趣味レベル: ソフトは無料。実費はGPUのみ。
- ビジネスレベル: 従量課金を完全に回避できる唯一の型。ただしGPUの初期費用と運用工数が価格に乗らない点に注意。

出典: [https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/](<https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/>)

### 音声・音楽

役割: 動画のBGM・ナレーション・効果音。権利条件がプラン単位で細かく切られており、最も事故りやすいカテゴリ。

ビジネス移行の条件: 広告・配信・企業案件に使う時点で、用途別にプランが上がる。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Suno | Suno | $0〜$30 | 席課金（1ユーザーあたり月額） | 条件付き（用途・プラン・クレジット種別で制限。例: 配信不可、ウォーターマーク有、生成物が既定公開） | medium |
| ElevenLabs | ElevenLabs | $0〜$990 | 席課金（1ユーザーあたり月額） | 条件付き（用途・プラン・クレジット種別で制限。例: 配信不可、ウォーターマーク有、生成物が既定公開） | medium |
| Kokoro TTS | オープンソース | 無料 | 自前ホスト（ソフト本体は無料、インフラ費のみ） | 商用利用可（有料プランで明示的に許諾） | medium |

#### Suno

- **Basic**: $0/月 — 50クレジット/日（約10曲）・非商用のみ
- **Pro**: $10/月 — 年払い8USD。2,500クレジット/月・商用可
- **Premier**: $30/月 — 年払い24USD。10,000クレジット/月・Studio DAW

- 趣味レベル: 無料枠は非商用のみ。しかも権利は生成時に確定するため、後から有料プランに上げても遡及しない。
- ビジネスレベル: 有料プランで作った曲は解約後も商用権利が残る。他ユーザーの曲をリミックスすると商用権利が外れる。学習データを巡る訴訟が継続中で、Content ID リスクは残る。

出典: [https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs](<https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs>) / [https://www.rightsdocket.com/insights/ai-music-rights-by-platform-2026](<https://www.rightsdocket.com/insights/ai-music-rights-by-platform-2026>)

#### ElevenLabs

- **Free**: $0/月 — 10,000クレジット/月・非商用
- **Starter**: $5/月 — 商用ライセンスはここから。配信は不可
- **Creator**: $22/月
- **Pro**: $99/月
- **Scale**: $299/月 — 広告・配信・企業・podcast がここで解禁
- **Business**: $990/月
- **Enterprise**: 要見積 — 映画・TV・劇場・ラジオ

- 趣味レベル: 無料は非商用かつ「Eleven Music」のクレジット表記が要る。
- ビジネスレベル: 権利が用途別に切られており、用途に合うプランに上げないと使えない（配信は Scale 以上、映画は Enterprise）。逆にアップグレードは過去の生成物にも遡及する。

出典: [https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs](<https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs>)

#### Kokoro TTS

- **自前実行**: $0/月 — Apache 2.0・商用可・CPUで動作

- 趣味レベル: 無制限・無料。
- ビジネスレベル: 読み上げ用途なら商用ライセンス料をゼロにできる。GPU不要な点が導入障壁を下げる。

出典: [https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/](<https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/>)

### 会議・議事録

役割: 商談・現場打ち合わせの記録。日本語精度とデータ保管場所が選定の決定要因。

ビジネス移行の条件: 機微な商談を扱う／日本語会議が中心／録音の保存期間を管理する時点でビジネス帯。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| tl;dv | tl;dv | $0〜$29 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Notta | Notta | $0〜 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Otter.ai | Otter.ai | $0〜$30 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | medium |
| Plaud | Plaud | 従量/要見積 | 席課金（1ユーザーあたり月額） | 商用利用可（有料プランで明示的に許諾） | low |

#### tl;dv

- **Free**: $0/月 — 録音は無制限だがAIノートは通算10回・録音は3ヶ月で自動削除
- **Pro**: $18/月 — 年払い/席
- **Business**: $26/月 — 年払い/席。ソースにより29USD

- 趣味レベル: 無料はAI要約が通算10回で月次リセットなし。しかも3ヶ月で録音が消える。
- ビジネスレベル: EU拠点でデータを欧州に保管。GDPR / EU AI Act 対応を明示。クリップ共有が強い。

出典: [https://theaiagentindex.com/agents/tldv](<https://theaiagentindex.com/agents/tldv>) / [https://toolchase.com/blog/best-ai-note-takers-2026/](<https://toolchase.com/blog/best-ai-note-takers-2026/>)

#### Notta

- **Free**: $0/月 — 120分/月・1回3分・要約10回/月
- **Premium**: 1980円/月 — 1,800分/月

- 趣味レベル: 無料枠は1回3分までなので会議には短い。
- ビジネスレベル: 日本語の公表精度98.86%・58言語。国内データ保管を重視する用途で第一候補。円建てで価格が読める。

出典: [https://uravation.com/media/ai-meeting-notetaker-comparison-2026/](<https://uravation.com/media/ai-meeting-notetaker-comparison-2026/>)

#### Otter.ai

- **Free**: $0/月 — 300分/月・1回30分・英語のみ
- **Pro**: $16.99/月 — 年払い約8.33USD。1,200分/月
- **Business**: $19.99/月

- 趣味レベル: 無料プランは英語のみで日本語非対応。日本語会議には使えない。
- ビジネスレベル: 英語会議が中心なら最も安い。Pro の分数が6,000→1,200分に減った点は導入前に確認する。

出典: [https://uravation.com/media/ai-meeting-notetaker-comparison-2026/](<https://uravation.com/media/ai-meeting-notetaker-comparison-2026/>)

#### Plaud

- **デバイス＋サブスク**: 要見積 — 本体2〜3万円台＋月額。月額はソースに明示なし

- 趣味レベル: 無料枠という概念が無く、ハード購入が前提。
- ビジネスレベル: 対面・現場・移動中の録音の現実解。Web会議ボット型ではないので、オンライン会議の自動参加には使えない。費用対効果は対面会議の本数で見積もる。

出典: [https://uravation.com/media/ai-meeting-notetaker-comparison-2026/](<https://uravation.com/media/ai-meeting-notetaker-comparison-2026/>)

### 業務自動化

役割: アプリ間の連携と定型処理。課金単位（タスク/クレジット/実行回数）の違いが実費を最も大きく左右する。

ビジネス移行の条件: 実行回数が月5万回を超えるあたりで、自前ホストとの損益分岐が逆転する。

| ツール | ベンダー | 価格帯(USD/月) | 課金単位 | 商用利用 | 確度 |
| --- | --- | --- | --- | --- | --- |
| Zapier | Zapier | $0〜$69 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |
| Make | Make | $0〜$38 | クレジット消費型 | 商用利用可（有料プランで明示的に許諾） | medium |
| n8n | n8n | $0〜$667 | 自前ホスト（ソフト本体は無料、インフラ費のみ） | 商用利用可（有料プランで明示的に許諾） | medium |

#### Zapier

- **Free**: $0/月 — 100タスク/月・2ステップのみ
- **Professional**: $29.99/月 — 年払い19.99USD。750タスク。49USDとするソースもあり
- **Team**: $69/月 — 年払い。2,000タスク・25席

- 趣味レベル: 無料は2ステップまでなので実務の自動化は組めない。
- ビジネスレベル: 課金単位がタスク（=ステップ数）なので、多段のワークフローほど高くつく。AIステップは1回で3〜5タスク消費する。連携先は7,000以上で最大。

出典: [https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/](<https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/>) / [https://toolchase.com/blog/ai-workflow-automation-guide/](<https://toolchase.com/blog/ai-workflow-automation-guide/>)

#### Make

- **Free**: $0/月 — 1,000クレジット/月・2シナリオ
- **Core**: $12/月 — 10,000クレジット。9USDとするソースもあり
- **Pro**: $29/月 — 16USDとするソースもあり
- **Teams**: $38/月

- 趣味レベル: 無料でも1,000クレジット／月あり、分岐の組み方次第で趣味用途は回る。
- ビジネスレベル: 同規模のワークフローで Zapier の1/6〜1/10の実費という試算。中小規模の ops に向く。

出典: [https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/](<https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/>) / [https://www.buildberg.co/blog/n8n-vs-make-vs-zapier](<https://www.buildberg.co/blog/n8n-vs-make-vs-zapier>)

#### n8n

- **Community（自前ホスト）**: $0/月 — fair-code。社内利用は無料。VPS 5〜20USD/月
- **Cloud Starter**: $24/月 — 年払い€20〜24。2,500実行
- **Cloud Pro**: $60/月 — €50〜60。10,000実行
- **Business**: $667/月 — 40,000実行＋自前ホストライセンス

- 趣味レベル: 自前ホストなら実行回数無制限。学習曲線は3つの中で最も急。
- ビジネスレベル: 課金単位が実行回数（ステップ数を見ない）。10ステップ×1万回でも1万実行。同条件で Zapier の約50分の1・Make の約6〜10分の1という試算。ただし再販（SaaS化）には有償ライセンスが要る。

出典: [https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/](<https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/>) / [https://www.bdemerson.com/article/n8n-vs-zapier](<https://www.bdemerson.com/article/n8n-vs-zapier>)

## 我々の用途への示唆

| 用途 | 現状 | 市況の最安入口 | ギャップ |
| --- | --- | --- | --- |
| 実装・コーディング | Claude Code / Codex / GLM Coding Plan / Cursor / Cerebras を併用（tools/ai-subscription-catalog.json） | GitHub Copilot Pro 10USD/席 | GLM は2026年に2度値上げし、年払いを避けるよう警告している記事がある。同じ作業を Copilot Pro(10USD) で代替できるなら、価格変動リスクを1社に集めない方が安全。 |
| 調査・リサーチ | Genspark Plus（契約済み） | Perplexity Free / NotebookLM Free | 出典付きの軽い調査は無料枠で足りる。Genspark の Plus は成果物生成（Sparkpage・スライド）に価値があり、単純検索の代替には不要。 |
| 画像生成 | 契約なし | FLUX.1 schnell（Apache 2.0・無料）／Adobe Firefly（IP補償付き） | 社外提案書に使うなら無料プランは全て不可（ウォーターマーク・既定公開・非商用）。法務リスクを避けるなら Firefly、コストを避けるなら schnell の自前ホスト。 |
| 動画生成 | 契約なし | Kling Standard 5.99USD/月 | ブース動線の再現は Kling の最安枠で試作し、採用が決まった案件だけ Runway / Veo に上げる二段構えが妥当。クレジットは翌月に繰り越されないため、試作と本番で契約を分ける。 |
| 会議・議事録 | 契約なし | Notta Premium 1,980円/月（日本語1,800分） | 日本語会議が中心なら Notta。無料枠を選ぶと Otter(英語のみ)・tl;dv(要約10回通算・3ヶ月で削除) は実務に届かない。円建てなので為替リスクが無い。 |
| 業務自動化 | 社内は Node スクリプト＋GitHub Actions が主体 | n8n Community（自前ホスト・無料） | 既にコードで回している処理を Zapier に移すと、課金単位がタスク（ステップ数）であるため逆に高くつく。自動化SaaSを検討するなら n8n の自前ホストが唯一整合する。 |

## 出典

1. [https://chatgpt.com/ja-JP/pricing](<https://chatgpt.com/ja-JP/pricing>)
2. [https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/](<https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/>)
3. [https://benchlm.ai/claude/pricing-plans](<https://benchlm.ai/claude/pricing-plans>)
4. [https://www.spendhound.com/blog/claude-pricing-negotiation-guide](<https://www.spendhound.com/blog/claude-pricing-negotiation-guide>)
5. [https://pc.watch.impress.co.jp/docs/news/2110129.html](<https://pc.watch.impress.co.jp/docs/news/2110129.html>)
6. [https://mashable.com/article/google-io-2026-gemini-ultra-ai-subscription-tiers](<https://mashable.com/article/google-io-2026-gemini-ultra-ai-subscription-tiers>)
7. [https://openclawlaunch.com/guides/ai-coding-plans-compared](<https://openclawlaunch.com/guides/ai-coding-plans-compared>)
8. [https://rankllms.com/coding-plans/](<https://rankllms.com/coding-plans/>)
9. [https://www.aimadetools.com/blog/how-to-choose-ai-coding-agent-2026](<https://www.aimadetools.com/blog/how-to-choose-ai-coding-agent-2026>)
10. [https://andrew.ooo/answers/cheapest-ai-coding-subscription-2026-glm-copilot-claude-cursor/](<https://andrew.ooo/answers/cheapest-ai-coding-subscription-2026-glm-copilot-claude-cursor/>)
11. [https://www.remio.ai/post/the-glm-coding-plan-went-viral-in-north-america-then-the-price-doubled](<https://www.remio.ai/post/the-glm-coding-plan-went-viral-in-north-america-then-the-price-doubled>)
12. [https://aiagentsquare.com/category/research-ai-agents](<https://aiagentsquare.com/category/research-ai-agents>)
13. [https://eyalmarcus.com/en/blog/ai-tools-guide-2026/](<https://eyalmarcus.com/en/blog/ai-tools-guide-2026/>)
14. [https://jiangren.com.au/blog/notebooklm-guide-05-faq](<https://jiangren.com.au/blog/notebooklm-guide-05-faq>)
15. [https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html](<https://www.anygen.io/showcase/zi-liao-zuo-cheng-ai-bi-jiao/index.html>)
16. [https://toolradar.com/guides/best-ai-image-generators](<https://toolradar.com/guides/best-ai-image-generators>)
17. [https://aiweekly.co/learning-ai/ai-applications/best-ai-image-generators](<https://aiweekly.co/learning-ai/ai-applications/best-ai-image-generators>)
18. [https://www.layer3labs.io/comparisons/ideogram-alternatives](<https://www.layer3labs.io/comparisons/ideogram-alternatives>)
19. [https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1](<https://zenn.dev/donaldxs/articles/5bb7fd8327a1d1>)
20. [https://www.layer3labs.io/comparisons/stable-diffusion-alternatives](<https://www.layer3labs.io/comparisons/stable-diffusion-alternatives>)
21. [https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026](<https://parallax.kr/en/blog/ai-video-generator-pricing-compared-2026>)
22. [https://socialsight.ai/blog/best-ai-video-models-2026-costs](<https://socialsight.ai/blog/best-ai-video-models-2026-costs>)
23. [https://academy.techpresso.co/reviews/is-runway-worth-it](<https://academy.techpresso.co/reviews/is-runway-worth-it>)
24. [https://toolindex.net/blog/ai-video-generation-sora-vs-kling-vs-runway-2026](<https://toolindex.net/blog/ai-video-generation-sora-vs-kling-vs-runway-2026>)
25. [https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/](<https://www.creativeainews.com/articles/best-free-ai-tools-creators-2026/>)
26. [https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs](<https://www.licenseorg.com/blog/ai-music-licensing-suno-elevenlabs>)
27. [https://www.rightsdocket.com/insights/ai-music-rights-by-platform-2026](<https://www.rightsdocket.com/insights/ai-music-rights-by-platform-2026>)
28. [https://theaiagentindex.com/agents/tldv](<https://theaiagentindex.com/agents/tldv>)
29. [https://toolchase.com/blog/best-ai-note-takers-2026/](<https://toolchase.com/blog/best-ai-note-takers-2026/>)
30. [https://uravation.com/media/ai-meeting-notetaker-comparison-2026/](<https://uravation.com/media/ai-meeting-notetaker-comparison-2026/>)
31. [https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/](<https://momentumsquads.com/blog/n8n-vs-make-vs-zapier/>)
32. [https://toolchase.com/blog/ai-workflow-automation-guide/](<https://toolchase.com/blog/ai-workflow-automation-guide/>)
33. [https://www.buildberg.co/blog/n8n-vs-make-vs-zapier](<https://www.buildberg.co/blog/n8n-vs-make-vs-zapier>)
34. [https://www.bdemerson.com/article/n8n-vs-zapier](<https://www.bdemerson.com/article/n8n-vs-zapier>)
