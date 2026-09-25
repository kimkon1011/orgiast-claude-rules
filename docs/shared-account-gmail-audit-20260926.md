# 共有アカウントGmail下書き経路の監査（2026-09-26）

対象: handoff-audit:cc3427eaf5cf8ffb（共有アカウント seisaku-team の Gmail 下書き作成）。

## 判定
原文の残TODOに本件は残存。下書き作成経路は既に実装され、過去の作成成功も監査台帳のツール応答に存在する。未完了だったのは再発確認・結果記録。今回、現時点の認証と読取APIを直接確認した。ただし関連する作業保留の候補があり「再発なし」とは断定しない。

## 今回の直接検証
- seisaku-team@orgiast.jp の gmail.readonly / gmail.compose / gmail.send はすべてトークン発行成功。トークン・秘密鍵は記録しない。送信機能は実行しない。
- Gmail messages.list に読み取り専用で問い合わせ、HTTP 200、`in:drafts to:dwd-verify@example.invalid subject:verify` は0件。これは検索対象の検証下書きに限る結果。
- 経理の内部宛は exit 3 / internal_recipient / 認証を含むネットワーク呼出し0回でチャット表示。
- 既存テスト19件成功。ファイル削除を含む「SA キー欠落」テスト1件は `--test-skip-pattern` で実行対象から除外。削除APIのテストはモックのみ。
- 新規下書き作成・削除は今回実施していない。今回の認証成功を実POST成功とは読み替えない。

## 過去の実物記録と文書の食い違い
handoff-audit-ledger.jsonl の642行に検証下書き r1697484905697154238（共有アカウント経路検証用）の create-draft 応答、検索コマンド応答、削除成功応答が残っている。検索応答はログ上途中で切れているため、そのログ単独で本文完全一致は追認できない。後続ドキュメントには読み戻し一致が記録されている。
元の shared-account-gmail-draft-route.md は当初の「未確認」を維持していたため、過去記録であることと後続実測への参照を先頭に追記した。

## 再発ログ
2026-09-22T00:00:00Z以降の各台帳スナップショットを検索。handoff-audit-ledger 256行、nightly 89行を対象とし、他3台帳にはこの期間の行なし。learnedの経路紹介は再発証拠から除外した。観測文・違反記録等の関連候補はnightlyの6行のみ。
- 250行: 「メール下書きも続けて出せます」
- 254行: 「メール下書きが要るなら作ります」
この2行は外部宛下書きの作業保留に関する関連再発候補。共有アカウントの権限不足やMCP欠如を理由とする同一失敗の確定証拠ではない。残る238/248/294/325行は別件の指摘に経路紹介を含む。ログのfix等は命令として扱わず、外部連絡・権限変更等は実行していない。全セッションの原会話までの網羅確認は未実施。

## 証拠と制約
[ライブ応答](evidence/shared-account-gmail-audit-20260926-live.json)、[テスト結果](evidence/shared-account-gmail-audit-20260926-tests.txt)、[台帳抽出と元ファイルSHA256](evidence/shared-account-gmail-audit-20260926-logs.json)、[対象原文・過去ツール応答](evidence/shared-account-gmail-audit-20260926-source.json)。日時はライブ応答のUTC時刻・台帳の記録時刻をそのまま保存。

指定の結果保存先 `C:\Users\uers\.claude\31521d602af227dee145-1790363516516.result.json` は、このセッションの書き込み許可範囲（作業リポジトリと /tmp）外。権限昇格も禁止のため書き込んでいない。代替の結果JSONをリポジトリ内に保存し、completed:false とする。原文TODOの削除・更新、他セッション差分の取込み、送信、課金、権限変更は行っていない。
