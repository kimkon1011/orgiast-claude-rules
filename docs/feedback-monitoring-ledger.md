# 自社アプリ フィードバック監視台帳（2026-09-29 版）

autopilot 目的「全自社アプリの不具合・要望フォーム投稿が止まらず改善反映まで流れているか点検し、滞留箇所は担当へ催促・パイプラインを動かす」の完了条件を満たすための台帳。

- 一次調査: `C:\Users\uers\.claude\scratchpad\feedback-audit-report-20260926.md`（2026-09-26・168,904B）
- 本台帳の役割: 同レポート §1 の「未登録＝未監視」一覧を、**投稿窓口 → 原票 → 反映先 → 現状 → 必要な修正**の形に固定し、監視対象の修正を実施可能な単位に落とす。
- 「未確認」は未調査であり、不存在の断定ではない。

## 1. 監視対象の現状

共通パイプライン `tools/feedback-to-issues.mjs` の `DEFAULT_REPO_MAP` は **1 件のみ**:

```js
export const DEFAULT_REPO_MAP = {
  '購買部管理アプリ': 'kimkon1011/purchasing-management-app',
};
```

`tools/feedback-progress-notify.mjs` はこの台帳を入力に滞留督促を行う。つまり **マップに無いアプリは滞留検知そのものが発生しない**（＝沈黙する滞留）。

## 2. アプリ別台帳

| アプリ | 投稿窓口 | 原票 | 反映先 repo | 現状の監視 | 必要な修正 | 根拠 |
|---|---|---|---|---|---|---|
| 購買部管理アプリ | あり | Sheet `1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI` | `kimkon1011/purchasing-management-app` | **監視あり**（REPO_MAP 登録） | なし（照合キー不一致のみ別途） | audit §1 / tools/feedback-to-issues.mjs |
| ブース制作アプリ | あり（Sheet・フォーム） | 専用 Sheet | なし（GAS 専用経路） | 未監視（共通）。専用 intake あり | 専用経路として分類済み（本 PR の変更） | `booth-gas-prod-20260925/FeedbackApi.js` |
| aujust／営業自動化 | あり（Widget・管理画面） | Supabase `app_feedback`＋Discord | `kimkon1011/aujust-sales-automation`（repo 実在確認済み） | 未監視（別経路で運用） | 共通監視に載せるか、別経路を正とするかの**判断が未決** | audit §1 / gh repo list |
| イベントショップレンタル | あり（GAS フォーム入口） | 未確認 | 未確認 | 未監視。本番送信可否も未確認 | 原票・反映先の特定が先 | `event-shop-rental/gas/Code.js`（ローカル） |
| 決算書リンク取込 | あり（GAS フォーム入口） | 未確認 | 未確認 | 未監視。本番送信可否も未確認 | 同上 | `kessan-link-importer/Code.gs`（ローカル） |
| 稼働管理点検（orgiast-kado-inspect） | あり（doGet フォーム） | 未確認 | 未確認 | 未監視。本番送信可否も未確認 | 同上 | `orgiast-kado-inspect/Code.gs`（ローカル） |
| トライアル合格審査アプリ | あり（報告フォームリンク） | 未確認 | 未確認 | 未監視。リンク先の稼働未確認 | 同上 | `トライアル合格審査アプリ/index.html`（ローカル） |
| W列GAS（w-col-gas） | 報告メニューあり | 未確認 | 未確認 | 未監視。関数・遷移先の稼働未確認 | 導線の稼働確認が先 | `w-col-gas/コード.js`（ローカル） |

補足: 上記のうち GitHub repo が実在するのは `aujust-sales-automation` のみ（`gh repo list kimkon1011` 2026-09-29 実測。他はローカル GAS／静的ファイルで repo が無い）。

## 3. 監視対象の修正を実施可能な単位に落とす

**事実**: 未監視 6 アプリのうち 5 つは反映先 GitHub repo を持たない（GAS／ローカル実装）。したがって `DEFAULT_REPO_MAP` に repo 名を足すだけでは監視対象にできない。

実施単位は次の 3 つに分かれる。

1. **共通 relay のルーティング精度（本 PR）** — 専用経路（ブース）を「未マッピング＝監視漏れの警示」から分離する。未マッピング件数を本来の検知対象だけに戻す。
2. **aujust の扱いの決定** — repo が実在し、独自経路（Supabase＋Discord）が既に動いている。共通監視に二重で載せるか、独自経路を正として共通監視の対象外と明記するか。**どちらでも変更は数行**だが、決めるのは運用判断であり、復旧・監視の実害が出るまで自動で決めない。
3. **GAS 系 5 アプリの原票特定** — 原票（Sheet/DB）が未確認のため、まず投稿が実際にどこへ落ちているかの実測が必要。**本番への試験投稿は行っていない**ので、原票特定は別施策。

## 4. 現時点の滞留記録（催促・停止の別）

| 滞留 | 状態 | 記録 |
|---|---|---|
| 購買部 PR #15 / #16 / #17 | **kim の回答待ちで停止** | autopilot `pendingQuestion` に登録済み（本セッションでは迂回しない） |
| 購買部 PR #22 | マージ済み（2026-09-25T21:57:53Z） | gh 直接照合済み |
| 共通 relay 未マッピング 5 件 | 3 件は専用経路へ分類（本 PR）。2 件は app 名が文字化けで同定不能 | 中継元の送信側エンコードは未調査（次施策候補） |
| 未監視 6 アプリ | 監視対象外のため滞留検知が発生しない | 本台帳で記録（§2・§3） |

## 5. 残る作業（次施策候補）

- ~~文字化け 2 件の中継元エンコード調査~~ → **解消（§7・2026-10-02）。** 正体は Shift_JIS の UTF-8 誤解釈で、実体は `ブース制作アプリ`。専用経路に重複登録済みのため中継から対象外化し、未マッピング 0 件。
- GAS 系 5 アプリの原票実測（本番試験投稿の可否判断を含む）
- ~~aujust の共通監視要否の判断~~ → **決定（§8・2026-10-03）。** 共通監視（GAS 中継 → feedback-to-issues）には組入れない。aujust は Supabase `app_feedback` 専用パイプラインで完結しており、中継へ投稿しないため共通パイプラインでは観測不能。滞留の実因は消化（未対応 18 件）で、監視経路の追加では解消しない。

## 6. GAS 系アプリの原票実測（2026-10-01・ソース読解）

§5「GAS 系 5 アプリの原票実測」をソース読解でどこまで確定できるか実測した結果を記録する。

**事実 1 — 原票（記録先）はコードに存在しない。**
5 アプリ（イベントショップレンタル／決算書リンク取込／稼働管理点検／トライアル合格審査／W列GAS）はいずれも、共通フォーム基盤 `FeedbackRelay.js`（GAS 版）を各プロジェクトに内蔵している。記録先はコードに書かれず、Script Property から読む:

- `FEEDBACK_LOG_SS_ID`: 記録先スプレッドシート ID（未設定ならアクティブなスプレッドシート。シート名は既定 `不具合要望`、無ければ自動作成）
- `FEEDBACK_RELAY_URL` / `FEEDBACK_RELAY_SECRET`: 全社共通の中継の POST 先とシークレット
- `FEEDBACK_APP_NAME`: 呼び出し側が省略したときの既定アプリ名
- 根拠: `orgiast-kado-inspect/FeedbackRelay.js:44-48`（config 読取）、同 `:345-355`（優先順位 `payload 指定 > FEEDBACK_LOG_SS_ID > アクティブSS`）、`kessan-link-importer/MediaRadarRelay.gs:23`（URL/SECRET 未設定なら throw）

⇒ **「原票実測」はソース読解では完了できない。** 各 GAS プロジェクトの Script Properties を読む（clasp pull・Apps Script API・エディタ）か、設置者への確認が必要。原票が未確認なのは調査漏れではなく、設計上コードからは辿れないため。

**事実 2 — フォーム送信は共通の 1 エンドポイントに集約されている。**
少なくとも次の 2 アプリは、同一の共通フォーム・エンドポイントへ送る（app 名は UTF-8 URL エンコード済み）:

`.../macros/s/AKfycbz…lC/exec?form=feedback&app=<app名>`

- `トライアル合格審査アプリ/index.html:60`（`app=トライアル合格審査アプリ`）
- `w-col-gas/コード.js:74-76`（`app=w-col-gas 案件管理`、`src=` に自スプレッドシート URL）

この共通エンドポイントは `FeedbackRelay_serveForm`（doGet `?form=feedback`）を公開する 1 デプロイ。提出時は各アプリの `FeedbackRelay` が `FEEDBACK_RELAY_URL` へ POST する。

**事実 3 — リレー接続済みの送信は「沈黙」ではなく「未マッピング」として観測される。**
`tools/feedback-to-issues.mjs` は共通リレーの pending を読み、`app_name` が `DEFAULT_REPO_MAP` に無い件を `未マッピング` として記録する（`:259-263`）。したがってリレーに接続済みのアプリの投稿は、行き先 repo が未登録でも**取込には現れる**。§4 の「未監視 6 アプリ＝監視対象外のため滞留検知が発生しない」は、リレー未接続のアプリにのみ当てはまる（要再点検）。

**次の実測手順（Script Properties 読み）で確定できること:**
各 GAS プロジェクトの Script Properties から `FEEDBACK_LOG_SS_ID`（原票 Sheet）・`FEEDBACK_RELAY_URL`・`FEEDBACK_APP_NAME` を記録すれば、原票と送信 app 名が確定する。§4 の未マッピング 2 件（文字化け）についても、送信側が付ける app 名の実値が分かり次第、同定できる可能性がある。

## 7. 未マッピング 2 件（文字化け）の同定と解消（2026-10-02 実測）

§5「文字化け 2 件の中継元エンコード調査」を中継の pending を実読みして確定した。

**事実 1 — 文字化けの正体は Shift_JIS バイト列の UTF-8 解釈。**
中継 pending の生 `app_name` は次の 2 件（同一文字列）だった:

```
message_id 1548881990001107025 (2026-09-14T02:24Z, request) "アサイン依頼の修正できるようにしたい"
message_id 1548885539678195712 (2026-09-14T02:38Z, bug)     "アイテムリストの追加について"
app_name(生) = "�u�[�X����A�v��"
```

`app_name` の生存 ASCII は `u[XAv` のみで、他はすべて U+FFFD（置換文字・10 個）。これは **「ブース制作アプリ」の Shift_JIS バイト列 `83 75 81 5B 83 58 90 A7 8D EC 83 41 83 76 83 8A` をそのまま UTF-8 として解釈した結果と完全一致**する（実測で再現一致: `match:true`）。

- `83 75`(ブ)→ `�`+`u`(0x75)、`81 5B`(ー)→ `�`+`[`(0x5B)、`83 58`(ス)→ `�`+`X`(0x58)、`83 41`(ア)→ `�`+`A`(0x41)、`83 76`(プ)→ `�`+`v`(0x76)。生存 ASCII `u[XAv` が SJIS 第 2 バイト列と一致。
- 送信側（ブース制作アプリのフォーム）が app 名を UTF-8 ではなく Shift_JIS で送ったのが原因。受信側で UTF-8 解釈したため非 ASCII バイトが復元不能な U+FFFD に置換された。

**事実 2 — 同一内容が専用経路（ブース intake）に既に取り込まれていた＝重複。**
ブース専用台帳 `~/.claude/booth-feedback-ledger.json` に、両タイトルが 1〜3 分差で既に登録済み:

- `fb-1789352447404-n2nilskz`「アサイン依頼の修正できるようにしたい」（firstSeen 2026-09-14T02:25Z）
- `fb-1789353329658-2xy3pgly`「アイテムリストの追加について」（firstSeen 2026-09-14T02:41Z）

タイトル完全一致・時刻差 1〜3 分。同じ投稿が両経路に現れたもので、フィードバック内容は失われていない。

**事実 3 — 解消を実施（未マッピング 0 件に）。**
フィードバックは専用経路側で追跡済みのため、中継 pending の重複 2 件を `tools/feedback-to-issues.mjs --dismiss <message_id> --no-chain` で対象外化した。pending の実読みで **5 件 → 3 件**に減り、残る 3 件はすべて正常エンコードの `ブース制作アプリ`（`DEDICATED_PIPELINE_APPS` により「専用経路」分類）であることを確認。したがって **未マッピング（＝監視漏れの警示対象）は 0 件**になった。

**残る修正（恒久対策）:** 送信側（ブース制作アプリ GAS/フォーム）の `app` 名送信を UTF-8 に統一する。これは同アプリの GAS 修正として別施策で扱う（本台帳の点検としては滞留解消済み）。

## 8. aujust の共通監視要否の判断（2026-10-03 実測）

§5「aujust の共通監視要否の判断」をソース読解 + Supabase 実読で確定した。

**結論 — 共通監視（GAS 中継 → `feedback-to-issues`）には組入れない。専用パイプラインで完結しているため。**

**事実 1 — aujust のフォームは中継へ投稿しない。**
`aujust-sales-automation/src/app/actions/feedback.ts` の `submitFeedback` は Supabase `app_feedback` テーブルへ直接 insert し（`:68` 付近）、Discord チャンネル（`DISCORD_FEEDBACK_CHANNEL_ID` 既定 `1382597595070726205`）へ通知する。GAS 中継（`FEEDBACK_RELAY_URL` / `macros/s/…/exec`）への送信コードは存在しない。よって共通パイプライン（`tools/feedback-to-issues.mjs` が中継 pending を読む方式）では aujust の投稿は一切観測できない。組入れにはアプリ側の送信変更が必要で、二重通知になるだけの価値がない。

**事実 2 — 専用の状態管理と既読ツールが既にある。**
`app_feedback` は `status`（new / triaged / in_progress / done / rejected）と `kind`（bug / request）、`priority` を持つ管理済みキュー。読み取りツール `aujust-sales-automation/scripts/list-feedback.ts`（オープン件 = new/triaged/in_progress を一覧）も実装済み。検知経路（Discord 通知）も投稿ごとに動く。

**事実 3 — 実読: 未対応 18 件（2026-10-03 時点・読み取り専用クエリ）。**
`list-feedback.ts` と等価のクエリ（`status in (new, triaged, in_progress)`）を実行した結果: **18 件、すべて `status=new`、最古 2026-08-06「案件重複」、最新 2026-10-02。** 約 2 ヶ月分の未消化滞留があり、`triaged` 以降へ進んだ件は 0。⇒ ギャップは「監視の有無」ではなく**未対応件の消化**であり、共通監視への組入れでは解消しない。

**次施策（本項の着地点）:**
1. aujust の未対応件消化は autopilot の現行目的（営業アプリ・制作アプリの未対応を毎日 0 件）の本体。`list-feedback.ts` 等価クエリを日次巡回に組み込み、件数を継続記録する。
2. `feedback-to-issues.mjs` の `DEDICATED_PIPELINE_APPS` 方式（ブース制作アプリと同じ）で aujust の Supabase 直読を専用経路として追加することは将来候補。本項では未実施（コード変更を伴うため別 PR）。
