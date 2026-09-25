<!-- このファイルは tools/compute-cost-pilot.mjs --write が生成する。手で編集しない。 -->
# 計算リソースの月額比較

ここに載るのはすべて『定価』であり、実際の請求額ではない。実際の請求額は各プロバイダの請求画面が一次情報であり、このカタログだけから支出を断定してはならない。

価格基準日: 2026-09-26

カタログに記載された基本料金と従量単価で計算する。未記載の超過単価は式上0として扱うため、実際の無料枠内での利用可否や機能の代替可能性を保証しない。

## 社内向け静的アプリ配信（apps/ の4アプリ相当）

商用利用: なし

| 前提メーター | 数量 | 単位 |
| --- | ---: | --- |
| requests | 0.3 | 百万リクエスト/月 |
| cpuMs | 0 | 百万CPUミリ秒/月 |
| transferGb | 20 | GB/月 |
| dbGb | 0 | GB（保存量） |
| fnInvocations | 0 | 百万回/月 |
| peakRequestsPerDayMillions | 0.05 | 百万リクエスト/日（ピーク） |

| 候補（ID） | 基本料金/月 | 超過料金/月 | 月額 | verified | 適格性 | 出典 | 注記 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Google Apps Script Web App（gas-webapp-free） | $0.00 | $0.00 | $0.00 | 未確認 | 適格 | https://developers.google.com/apps-script/guides/services/quotas | オージャストの現行配信基盤（fleet-status-sheet 等）。Consumer/Workspace アカウントの割当内は無料だが、今回の一次情報取得では金額を確認できていない（verified:false）。日次クォータは種類ごとに別で、月額への換算は単純化できない。 |
| GitHub Pages (public repo)（github-pages-free） | $0.00 | $0.00 | $0.00 | 未確認 | 適格 | https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages | 公開リポジトリの Pages は無料という記載は広く知られているが、今回の一次情報取得では金額を確認できていない（verified:false）。プライベートリポジトリでは有料プランが要る点も未確認。金額は台帳に載せるが、確定分には数えない。 |
| Cloudflare Workers Free（cloudflare-workers-free） | $0.00 | $0.00 | $0.00 | 一次情報 | 適格 | https://developers.cloudflare.com/workers/platform/pricing/ | 無料枠は『10万リクエスト/日』の日次上限。月間合計ではなく日次ピークで判定する必要がある（月300万でも1日に10万を超えた日があれば翌日以降は有料プランが要る）。 |
| Cloudflare Workers Paid（cloudflare-workers-paid） | $5.00 | $0.00 | $5.00 | 一次情報 | 適格 | https://developers.cloudflare.com/workers/platform/pricing/ | 公式ページの実測値: 基本 $5/月・1000万リクエスト同梱・3000万CPUミリ秒同梱・超過 $0.30/百万リクエスト・$0.02/百万CPUミリ秒。 |
| Vercel Hobby（vercel-hobby） | $0.00 | $0.00 | $0.00 | 一次情報 | 適格 | https://vercel.com/pricing | 公式ページの実測値: $0/月・Fast Data Transfer 100GB/月・Edge Requests 100万/月・Function Invocations 100万/月・Fluid Active CPU 4時間/月。**商用利用は不可**（商用は Pro 以上）。 |
| Vercel Pro（vercel-pro） | $20.00 | $0.00 | $20.00 | 一次情報 | 適格 | https://vercel.com/pricing | 公式ページの実測値: $20/月（開発者1席あたり）。Fast Data Transfer 1TB/月同梱・超過 $0.15/GB。Edge Requests 1000万/月同梱・超過 $2/百万から。Function Invocations は $0.60/百万から（同梱枠の記載なし＝未確認のため included に入れていない）。 |
| Netlify Free（netlify-free） | $0.00 | $0.00 | $0.00 | 一次情報 | 適格 | https://www.netlify.com/pricing/ | 公式ページの実測値: $0/月。ただし同梱帯域（GB）はページに記載が無く、『20 credits per GB』の従量表記のみ。無料枠の帯域上限は未確認なので included に入れない（推測で埋めない）。 |
| Netlify Pro（netlify-pro） | $20.00 | $0.00 | $20.00 | 一次情報 | 適格 | https://www.netlify.com/pricing/ | 公式ページの実測値: $20/月（unlimited members 表記。席単価ではない）。帯域の同梱枠はページに記載が無いため未確認。 |

最安: Google Apps Script Web App（gas-webapp-free） $0.00/月
現行: Google Apps Script Web App（gas-webapp-free） $0.00/月
削減額: $0.00/月

> ⚠️ この比較は一部未確定（未計測 0 件）

## 社外公開の静的サイト（学会協賛ナビ等・商用）

商用利用: あり

| 前提メーター | 数量 | 単位 |
| --- | ---: | --- |
| requests | 2 | 百万リクエスト/月 |
| cpuMs | 0 | 百万CPUミリ秒/月 |
| transferGb | 60 | GB/月 |
| dbGb | 0 | GB（保存量） |
| fnInvocations | 0 | 百万回/月 |
| peakRequestsPerDayMillions | 0.2 | 百万リクエスト/日（ピーク） |

| 候補（ID） | 基本料金/月 | 超過料金/月 | 月額 | verified | 適格性 | 出典 | 注記 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Cloudflare Workers Free（cloudflare-workers-free） | $0.00 | $0.00 | $0.00 | 一次情報 | 不適格: 無料枠の日次上限を超える（無料枠は月間合計では判定できない） | https://developers.cloudflare.com/workers/platform/pricing/ | 無料枠は『10万リクエスト/日』の日次上限。月間合計ではなく日次ピークで判定する必要がある（月300万でも1日に10万を超えた日があれば翌日以降は有料プランが要る）。 |
| Cloudflare Workers Paid（cloudflare-workers-paid） | $5.00 | $0.00 | $5.00 | 一次情報 | 適格 | https://developers.cloudflare.com/workers/platform/pricing/ | 公式ページの実測値: 基本 $5/月・1000万リクエスト同梱・3000万CPUミリ秒同梱・超過 $0.30/百万リクエスト・$0.02/百万CPUミリ秒。 |
| Vercel Pro（vercel-pro） | $20.00 | $0.00 | $20.00 | 一次情報 | 適格 | https://vercel.com/pricing | 公式ページの実測値: $20/月（開発者1席あたり）。Fast Data Transfer 1TB/月同梱・超過 $0.15/GB。Edge Requests 1000万/月同梱・超過 $2/百万から。Function Invocations は $0.60/百万から（同梱枠の記載なし＝未確認のため included に入れていない）。 |
| Netlify Pro（netlify-pro） | $20.00 | $0.00 | $20.00 | 一次情報 | 適格 | https://www.netlify.com/pricing/ | 公式ページの実測値: $20/月（unlimited members 表記。席単価ではない）。帯域の同梱枠はページに記載が無いため未確認。 |
| GitHub Pages (public repo)（github-pages-free） | $0.00 | $0.00 | $0.00 | 未確認 | 適格 | https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages | 公開リポジトリの Pages は無料という記載は広く知られているが、今回の一次情報取得では金額を確認できていない（verified:false）。プライベートリポジトリでは有料プランが要る点も未確認。金額は台帳に載せるが、確定分には数えない。 |

最安: GitHub Pages (public repo)（github-pages-free） $0.00/月
削減額: 未算定（現行または最安の金額が不明）

> ⚠️ この比較は一部未確定（未計測 0 件）

## 社内API + DB（フィードバック受付・購買部等）

商用利用: なし

| 前提メーター | 数量 | 単位 |
| --- | ---: | --- |
| requests | 1 | 百万リクエスト/月 |
| cpuMs | 5 | 百万CPUミリ秒/月 |
| transferGb | 30 | GB/月 |
| dbGb | 1 | GB（保存量） |
| fnInvocations | 1 | 百万回/月 |
| peakRequestsPerDayMillions | 0.1 | 百万リクエスト/日（ピーク） |

| 候補（ID） | 基本料金/月 | 超過料金/月 | 月額 | verified | 適格性 | 出典 | 注記 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Cloudflare Workers Paid（cloudflare-workers-paid） | $5.00 | $0.00 | $5.00 | 一次情報 | 適格 | https://developers.cloudflare.com/workers/platform/pricing/ | 公式ページの実測値: 基本 $5/月・1000万リクエスト同梱・3000万CPUミリ秒同梱・超過 $0.30/百万リクエスト・$0.02/百万CPUミリ秒。 |
| Vercel Pro（vercel-pro） | $20.00 | $0.60 | $20.60 | 一次情報 | 適格 | https://vercel.com/pricing | 公式ページの実測値: $20/月（開発者1席あたり）。Fast Data Transfer 1TB/月同梱・超過 $0.15/GB。Edge Requests 1000万/月同梱・超過 $2/百万から。Function Invocations は $0.60/百万から（同梱枠の記載なし＝未確認のため included に入れていない）。 |
| Supabase Free（supabase-free） | $0.00 | $0.00 | $0.00 | 一次情報 | 適格 | https://supabase.com/pricing | 公式ページの実測値: $0/月・DB 500MB・egress 5GB。 |
| Supabase Pro（supabase-pro） | $25.00 | $0.00 | $25.00 | 一次情報 | 適格 | https://supabase.com/pricing | 公式ページの実測値: $25/月（プロジェクトあたり DB 8GB・egress 250GB・ファイルストレージ 100GB）。超過単価はページから取得できていないため meters に入れない。 |

最安: Supabase Free（supabase-free） $0.00/月
削減額: 未算定（現行または最安の金額が不明）

## DB が無料枠を超えた場合の比較

商用利用: あり

| 前提メーター | 数量 | 単位 |
| --- | ---: | --- |
| requests | 3 | 百万リクエスト/月 |
| cpuMs | 10 | 百万CPUミリ秒/月 |
| transferGb | 120 | GB/月 |
| dbGb | 10 | GB（保存量） |
| fnInvocations | 3 | 百万回/月 |
| peakRequestsPerDayMillions | 0.3 | 百万リクエスト/日（ピーク） |

| 候補（ID） | 基本料金/月 | 超過料金/月 | 月額 | verified | 適格性 | 出典 | 注記 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Cloudflare Workers Paid（cloudflare-workers-paid） | $5.00 | $0.00 | $5.00 | 一次情報 | 適格 | https://developers.cloudflare.com/workers/platform/pricing/ | 公式ページの実測値: 基本 $5/月・1000万リクエスト同梱・3000万CPUミリ秒同梱・超過 $0.30/百万リクエスト・$0.02/百万CPUミリ秒。 |
| Vercel Pro（vercel-pro） | $20.00 | $1.80 | $21.80 | 一次情報 | 適格 | https://vercel.com/pricing | 公式ページの実測値: $20/月（開発者1席あたり）。Fast Data Transfer 1TB/月同梱・超過 $0.15/GB。Edge Requests 1000万/月同梱・超過 $2/百万から。Function Invocations は $0.60/百万から（同梱枠の記載なし＝未確認のため included に入れていない）。 |
| Supabase Pro（supabase-pro） | $25.00 | $0.00 | $25.00 | 一次情報 | 適格 | https://supabase.com/pricing | 公式ページの実測値: $25/月（プロジェクトあたり DB 8GB・egress 250GB・ファイルストレージ 100GB）。超過単価はページから取得できていないため meters に入れない。 |

最安: Cloudflare Workers Paid（cloudflare-workers-paid） $5.00/月
削減額: 未算定（現行または最安の金額が不明）
