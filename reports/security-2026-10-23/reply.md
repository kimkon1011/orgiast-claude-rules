2026-10-23 実測。修正版・判定は依頼基準（公式公開状況はDNS失敗で未確認）。ローカル版であり本番版は未確認。更新・PR・マージ・再デプロイ未実施。

|対象（サイト/リポジトリ/PC）|URL|アカウント|技術と現在の版|修正版|状態|対応日と証拠（commit/URL）|
|---|---|---|---|---|---|---|
|PC・WSL|—|root|Node 22.23.3|22.23.4|要更新|10/23 node -v。MSI取得先DNS失敗、SHA256未確認|
|PC・Windows|—|未確認|Node/Java/MySQL/GitLab/Windows Update|依頼基準|未確認|10/23 PowerShell・winget起動がWSL socket failed 1|
|PC・WSL|—|root|PHP/Java/Go/MySQL|依頼基準|未確認|10/23 各コマンドなし。Windows導入有無は不明|
|event-shop（別作業コピー含む）|https://github.com/seisaku-team-org/event-shop|seisaku-team-org（remote）|Next 16.2.10 / React 19.2.4|16.4.1|要更新|10/23 package-lock.json|
|stagecue|https://github.com/nishiOrgiast/stagecue|nishiOrgiast（remote）|Next 16.3.4 / React 19.2.8|16.4.1|要更新|10/23 package-lock.json|
|cafe-checklist-app|https://github.com/nishiOrgiast/cafe-checklist-app|nishiOrgiast（remote）|Next 14.2.35 / React 18.3.1|15以上へ移行|要移行|10/23 package-lock.json。メジャー更新せず|
|purchasing-management-app（各作業コピー）|https://github.com/kimkon1011/purchasing-management-app|kimkon1011（remote）|Next 15.5.18 / engines.node >=20|15.5.28|要更新|10/23 pnpm-lock.yaml。稼働Nodeは未確認|
|nightly-repo・拡張・persol-booth-3d|—|未確認|package.jsonに対象依存なし|—|該当なし|10/23 manifest確認。公開状態は未確認|
|GAS・その他全管理対象/顧客案件|未確認|未確認|Laravel/PHP/Java/Go/MySQL/GitLab/RSC含む全件一覧・本番版|依頼基準|未確認|10/23 ghなし・gh.exe起動失敗、Vercel列挙取得不能。Netlify/Cloudflare/WP/レンタルサーバー未取得|
|公開サイトHTTP|未確認|未確認|HTTP/X-Powered-By|—|未確認|10/23 curl: stagecue/event-shop/cafe-checklist-app.vercel.app 全てDNS失敗（公開URL自体も未確定）|

外部DNSとWindows連携の復旧が必要。全PC・全案件の点検完了ではありません。
