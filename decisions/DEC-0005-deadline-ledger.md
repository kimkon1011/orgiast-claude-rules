# Decision Record

## decision_id
DEC-0005

## date
2026-11-03

## status(ACTIVE|SUPERSEDED)
ACTIVE

## project
deadline-watch（期限台帳）

## QUESTION
車検・訴訟・消防など期限のある義務を、kim が思い出して頼まなくても自動で見つけて追いかけ、確実に届ける方式をどれにするか。

## CONTEXT
- 2026-10〜11 に車検切れ（V220d 2026-10-27）・訴訟資料の提出期限切れ・消防の質問書の回答期限切れが起きた。
- kim 宛の Discord 通知は本数が多すぎて読まれず、2026-10-27 に全面禁止。kim-inbox（セッション回収台帳）も運用ノイズ（別PCへの連絡未達 info 580 件超）で溢れ、古い順 5 件しか表示されないため新着が見えない。
- 全プロジェクトは別アカウントへの移管を前提にし、外部リソースは最小にする（kim 2026-10-22）。アプリが呼ぶ LLM に Claude API は使わない（ONBOARDING §2.8.0）。

## OPTIONS
- (a) 期限台帳: Google スプレッドシートを正本に、夜間検出（Gemini 無料枠）＋毎朝の段階追跡＋kim-inbox の期限レーン（セッション先頭に割り込み）＋kim のカレンダー終日予定。
- (b) カレンダーのみ: 検出した期限を kim のカレンダーに入れるだけ。
- (c) 外部 SaaS（Notion / Asana / Todoist 等）に登録して通知させる。

## DECISION
(a) 期限台帳。カレンダー登録は (a) の届け方の一部として含める。

## WHY
- 追跡・状態・根拠・担当が 1 か所に残り、自動クローズ（返信メール検知・台帳の完了）で kim の手を使わない。
- 既存資産（vehicle-inspection-watch、kim-inbox、gmail-search、sheets-dwd、line-history-sync）の延長で作れ、追加アカウントも従量費用も要らない。
- セッション先頭への割り込みは、kim が毎日必ず見る唯一の場所（作業セッション）に届く。

## TRADE-OFF
- (b) の手軽さは捨てる（カレンダーだけなら実装半日）。
- (c) の UI・モバイル通知の完成度は捨てる。代わりにスプレッドシートを Galaxy の Sheets アプリで見る。
- kim-inbox のノイズを発生源で止める作業が前提として必要になる。

## ASSUMPTIONS
- Gemini 無料枠（OpenRouter 無料枠を予備）で 1 日 100 文書程度の抽出がまかなえる。
- DWD で kim@ / seisaku-team@ の Gmail・Drive・Sheets が読める（gmail-search で実測済み）。カレンダーのスコープは未確認で、403 なら同期だけ止める。
- kim は「D-003 完了」のような 1 言で返す運用を受け入れる。

## REVERSIBILITY(REVERSIBLE|PARTIALLY_REVERSIBLE|IRREVERSIBLE)
REVERSIBLE
