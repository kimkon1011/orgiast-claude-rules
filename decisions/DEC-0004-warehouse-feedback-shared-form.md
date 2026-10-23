# Decision Record

## decision_id
DEC-0004

## date
2026-10-15

## status(ACTIVE|SUPERSEDED)
ACTIVE

## project
倉庫アプリ（cr568/warehouse-app、GAS Web アプリ）

## QUESTION
倉庫アプリの「🐛 不具合・要望」を、アプリ内蔵の feedback-kit フォーム（方式A）で通知まで届けるか、全社共通フォームへのリンク（方式B）にするか。

## CONTEXT
- feedback-kit 1.0.0 は導入済み（本番 @60〜）だが、本番の `FeedbackRelay_ping` は中継 URL / secret・Bot DM・webhook がすべて未設定（2026-10-15 コマンドキューで実測）。内蔵フォームは記録だけで誰にも通知が届かない。
- 中継 secret は「全員配布を前提にしない」設計（`tools/feedback-kit/gas/INSTALL.md`）。cr PC の keyserve 配布には `feedback-relay.env` の `FEEDBACK_SHARED_FORM_URL` だけが入る。
- 共通フォームは匿名で開け、`app=` / `src=` をパラメータで受け、通知は共通側で設定済み（curl で 200・アプリ名表示を実測）。

## OPTIONS
- (a) 方式A: secret を取得して `Admin_setFeedbackRelay` を入れる（secret の配布経路が無い）
- (b) 方式B: ボタンで共通フォームを新タブで開く（kit ファイルは残し、URL 未設定時は内蔵ダイアログに戻る）
- (c) Bot トークンを Script Properties に置いて DM フォールバック（認証情報のクラウド複製になり ONBOARDING §2.11 で非推奨）

## DECISION
(b) 方式B。`constants.gs` に共通フォーム URL（private リポ）を置き、doGet が `?form=feedback&app=倉庫アプリ&src=<exec URL>` を組み立てて画面へ渡す。本番 @64 → kim-PC の @65 で修正済み（コメント内スクリプトレット事故）。

## WHY
- 追加の秘密値ゼロで、通知が実際に届く（共通フォーム経由のテスト送信で「送信しました」＝通知済みを実測）。
- kit の gate 検査（版・必須機能）はファイルを残すことで通過する。

## TRADE-OFF
- 画像添付・送信は共通フォーム側の UI に依存し、アプリ内で完結しない（新タブが開く）。
- 内蔵フォーム（記録のみ）は使われなくなるが残置される。

## ASSUMPTIONS
- 共通フォームが匿名公開で稼働し続ける。
- 中継 secret は今後も cr PC へ配布されない。

## REVERSIBILITY(REVERSIBLE|PARTIALLY_REVERSIBLE|IRREVERSIBLE)
REVERSIBLE

## REVISIT_TRIGGER
- 中継 secret が keyserve 経由で配布されるようになった → 方式A（内蔵フォーム＋通知）へ戻し、本 DEC を supersede する。
- 共通フォームの URL / パラメータ仕様が変わった。

## RELATED
- memory `project-warehouse-app-bihin` / `feedback-gas-template-scriptlet-in-comment-outage`
- `tools/feedback-kit/gas/INSTALL.md` 方式B
- warehouse-app commit 9732c65（方式B）・ff59e81（@65 修正）
