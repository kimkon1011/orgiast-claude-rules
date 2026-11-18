# 調査メモ（2026-11-18 12:50–13:00 JST）サイト英語化

金さんの依頼: 今のREブースのサイトも全部英語で表示されるようにして、あとオージャストのサイトも。Claude Codeで進める。

## 公式URL（確認済み）

- REブース（本番）: https://rebooth.co.jp/ （www は本体へ 301）
  - WordPress 7.1.4 / Apache / PHP 8.3.36
  - カスタムテーマ `rebooth`
  - All in One SEO 4.9.9、Contact Form 7 6.1.6、GTM-WGF3262B
  - 管理画面: https://rebooth.co.jp/wp-admin/
  - サーバー: ヘテムル（GMO、157.7.44.179）。NSはムームー。
- オージャスト（本番）: https://www.orgiast.jp/ （orgiast.jp は www へ 301）
  - WordPress（ルートではなく `/wp/` 配下。管理画面: https://www.orgiast.jp/wp/wp-admin/）
  - Apache / PHP 7.4.33
  - プラグイン（公開HTMLから確認）: Smart Slider 3、Instagram Feed、Jetpack 7.0、Shared Files、Table of Contents Plus、WordPress Popular Posts
  - GTM-PF9V8SR
  - All in One SEO Pack 2.11
- orgiast.co.jp / www.orgiast.co.jp: 2026-11-18時点で HTTP 500（Pingora）、HTTPS は TLS 失敗。公式サイトとしては使えない。英語化の対象は www.orgiast.jp。

## /en/ の現状（衝突注意）

- https://rebooth.co.jp/en/ および /en/about/ /en/company/ /en/contact/ は WordPress の 404。
- https://www.orgiast.jp/en/ も 404。
- `/en/expo-apply/` は別作業（PR #2312、GB-23）で静的公開予定。014 の nightly-repo の origin/main には既に `feat(expo-apply): rebooth.co.jp 配下公開に向けて問い合わせ送信とSEOを直す (#2312)` (27062c56) が入っている。
- **禁止:** apps/expo-apply と本番の /en/expo-apply/ を変更・上書き・削除しない。英語トップは /en/ に置き、expo-apply と共存させる。

## ページ数（sitemap / WP REST、2026-11-18）

### rebooth.co.jp
コアページ（REST 13、sitemap の固定ページ 12。column はページ扱いだが post-sitemap 側にもアーカイブあり）:
- / （トップ）
- /about/ リブースについて
- /why-choose-us/ 選ばれる理由
- /why-choose-us/design-quality/ 妥協しないデザイン性
- /why-choose-us/reuse/ 再利用を前提にした設計力
- /why-choose-us/reduces-costs/ 出展コストと環境負荷の両立
- /works-top/ 実績
- /news/ お知らせ一覧
- /column/ コラム
- /company/ 会社情報
- /contact/ お問い合わせ
- /thanks/ 送信完了
- /privacy-policy/ 個人情報保護方針

CPT・投稿:
- works 50
- exhibition 投稿 34 + production 1 + column アーカイブ 1（post-sitemap 36）
- news 4（/news/1112/ など）
- reviews 1（/reviews/1309/）
- client 40（/client/797/ など。ロゴ・顧客CPTの可能性）
- タクソノミーアーカイブ: industry_type, venue, booth_size, price_range, layout_type, base_color, decoration, category

### www.orgiast.jp
コアページ（REST 6 + アーカイブ系）:
- / トップ
- /company 会社概要
- /services サービス（/services/flow お申し込みの流れ）
- /contactus お問い合わせ
- /contactform-complete 送信完了
- /policy プライバシーポリシー
- /clients クライアント
- /recruiting 採用
- /event /creative /newsrelease /interview の一覧

CPT:
- event 85（一覧含む）
- creative 25（一覧含む）
- interview 14（一覧含む）
- newsrelease 25（一覧含む）
- topics 217
- 通常投稿 sitemap は 0

「全部」を一度に人手で英訳すると topics 217 だけで品質が落ちる。推奨フェーズは下記。

## 既存の翻訳プラグイン（重要）

rebooth のフロントに次が読み込まれているが、スイッチ本体（`<universally-switcher data-config>`）はホームページに出ておらず、/en/ も 404。導入済みだが英語は未公開・未接続の状態。

- プラグイン: Universally – AI Translation & Multilingual SEO（slug: universally-language-translation-multilingual-tool、v1.0.11）
- 方式: ページを複製せず、訪問時に HTML を AI 自動翻訳して `/en/` などのプレフィックスで出す。hreflang あり。
- 無料枠: 1言語・2,000語まで。本サイト全体には足りない。それ以上は有料（課金は金さんの承認が必要）。
- 金さんの方針どおり、自動翻訳ウィジェット／オンザフライAI翻訳だけで公開するのは品質・SEOの面で不可。
- 有効化すると /en/ をこのプラグインが取る可能性があり、/en/expo-apply/ と衝突しうる。

## 英語化の方式（決定）

**採用: 無料の Polylang（または同等の「ページを実体として持つ」無料多言語）＋人手のビジネス英語。URL は /en/ 配下。日本語ページと英語ページを切り替えるボタンと hreflang を付ける。**

理由:
- 有料プラグイン不要（課金承認が要らない）
- 英語が WordPress 上の実ページになるので、自動翻訳より品質とSEOが安定する
- Apache は実在するファイル・ディレクトリを index.php に回さないため、静的な /en/expo-apply/ は共存できる
- 既存の日本語ページは残す（削除禁止）

採用しない:
- Universally を英語公開の本体にする（自動翻訳、無料枠不足、課金、/en/ 衝突リスク）
- 翻訳ウィジェットのみ
- サイト全体を静的HTMLで複製（works / news / event の更新が追従できない）

フェーズ:
1. 両サイトのコアページ（ナビに出る固定ページ＋トップ＋問い合わせ＋会社概要＋ポリシー＋thanks）を英語化。切替ボタンと hreflang。フォームは英語ラベルで、送信先は現行のまま。
2. 実績・お知らせ・インタビュー・イベント・クリエイティブなど、一覧と主要個別ページ。
3. 残りの個別ページ（rebooth の works/exhibition/client、orgiast の topics など）。数字や実績は作らない。日本語原稿にない数値は出さない。

## ログイン手段の調査（値は見ていない）

確認したPC: 000, 008, 011, 014, 015, 018。
- FileZilla / WinSCP / Cyberduck の設定ディレクトリなし
- wp-cli なし
- .ssh は known_hosts のみ（秘密鍵ファイル名もなし）
- VS Code の sftp.json / .ftpconfig は浅い探索では見つからず
したがって、本番反映には 1Password 経由の WordPress 管理画面（および rebooth はヘテムルのファイルマネージャ）が必要。パスワード・トークンの値は見ない・書かない・コピーしない。
見つかるまで本番反映はしない。翻訳とリポジトリ上の準備は先に進める。

011 の `C:\Users\kimko\rebooth-lp` は別物（広告用 Next.js A/B LP、github.com/cr568/rebooth-lp）。今回の対象は本番 WordPress 2サイト。LPの .env は触らない。

## 会社情報（公開の会社ページから。Growi は未ログインで本文が取れず）

出典: https://rebooth.co.jp/company/ （2026-11-18取得）。www.orgiast.jp/company も照合用に取得済み。

- 社名: 株式会社オージャスト / Orgiast Co.,Ltd.
- 代表取締役社長: 金功勇（野村功勇）
- 設立: 2006年4月
- 資本金: 500万円
- 電話: 0120-487-121
- 東京本社: 〒130-0015 東京都墨田区横網2-10-3 1F
- 大阪本社: 〒537-0001 大阪府大阪市東成区深江北2-15-24東邦ビル 212（FAX 06-6976-0212）
- 倉庫: 埼玉渋井倉庫（川越市渋井1351-3）、埼玉第二倉庫（さいたま市西区西遊馬594）
- 営業所: 札幌、名古屋、広島、福岡、沖縄（住所は会社ページどおり）
- 業務: ブース制作、社内イベントの企画・プロデュース（社員総会、会社説明会、表彰式、社員旅行など）
- 沿革の主な事実（ページ記載どおり。数字の追加禁止）:
  - 2006年4月 設立
  - 2010年4月 大阪支店開設
  - 2014年3月 社内イベント百貨店オープン
  - 2020年11月 上場セレモニー専門プランニングサービス開始
  - 2022年6月 Reブース リリース
  - 2023年12月 第11回SDGsビジネスセミナーで SDGsビジネスホープ賞
  - 2024年1月19日 商標「Re:ブース」登録（第6772061号）
  - 2024年2月2日 大阪市新事業分野開拓事業者認定事業（ベンチャー調達制度）に認定
  - 2024年3月 福岡営業所、埼玉渋井倉庫
  - 2024年6月 埼玉第二倉庫
  - 2024年7月 札幌、名古屋、広島、沖縄営業所

英語では Re:ブース / Reブース を "Rebooth" または "Re:Booth" で統一し、初出で日本語名を補ってよい。会社名は Orgiast Co., Ltd.。代表者名は Takayuki Kim（要確認ではなく、公開英語表記が無いなら "Koyu Kim (Takayuki Nomura)" など勝手に作らず、まずは "Koyu Kim" と日本語名を併記し、STATUS に判断事項として残す）。

※「金功勇」の英語表記は公式英語ページがまだ無い。ローマ字を断定せず、STATUS の判断事項にする。

## 使ったPC

作業リポジトリは 014（DELL、展示会ブース担当）の `C:\Users\USER\.claude\nightly-repo`（origin/main が #2312 済みでクリーン）。専用 worktree を切って Claude Code Opus を起動する。
011 は orgiast.jp の PR #1899 や rebooth-lp の実績があるが、nightly-repo が古く dirty なため今回の本作業PCにはしない。
