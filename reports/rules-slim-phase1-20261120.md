# Claude Code ルール軽量化 第1段

## 配布サイズ

| 計測対象 | 変更前 | 変更後 | 上限 |
| --- | ---: | ---: | ---: |
| ONBOARDING.md（作業ツリーの CRLF） | 303,337 バイト | 302,522 バイト | — |
| ONBOARDING.md（リポジトリの LF） | 301,533 バイト | 300,723 バイト | 330,795 バイト |
| CLAUDE.md.template | 26,692 バイト | 26,293 バイト | — |
| 配布用 CLAUDE.md 全体 | 26,692 バイト | 26,293 バイト | 28,922 バイト |
| 索引ブロック（開始・終了マーカー、固定参照を含む） | 123行 | 116行 | — |
| 索引本文（makeIndex の戻り値） | 119行 | 112行 | — |

全体はテンプレートに `build(template, makeIndex(onboarding), "ONBOARDING.md")` を適用した UTF-8 サイズ。上限は変更後の実測値の110%を小数点以下切り捨て。ONBOARDING.md は Git の LF に正規化して検査する。

テンプレートの手書き部は既に Next.js と Growi の固有ルールだけだった。日本語・authuser・手間・トークン効率・effortLevel・Bash・kim-inbox のテンプレート内の記述は開始・終了マーカーの内側にあり、手書き部には重複がなかった。テンプレートは既存の `tools/render-claude-template.mjs` で再生成した。

## 決定事項1〜8

全文を下の変更台帳に掲載した。旧行番号は作業開始時、新行番号は変更後を指す。

| 決定 | 主な変更箇所と文言 |
| --- | --- |
| 1. 自動再開 | ONBOARDING.md:733 → 728、CLAUDE.md.template:84 → 80。「自動再開は廃止」から「タイトル頭に【MM/DD/HH:MMまで】の期限が付いたものだけ、期限を過ぎたら自動再開」に変更。待機手順と巡回の記述を同規定に接続。 |
| 2. 迷ったときのモデル | ONBOARDING.md:676 → 672、CLAUDE.md.template:75 → 72。「迷ったら Opus」を既定モデルの規定に残し、旧678行の重複を統合。旧「迷ったら Auto」は両文書に存在せず、`tools/claude-md-legacy.json:61` 付近の完全一致移行用 `text` にのみ存在。既配布の旧文を消す照合キーとして原文を保持し、`requires` を新しい規定へ更新した。 |
| 3. 報告 | ONBOARDING.md:217–221 → 215–217、674、CLAUDE.md.template:51–52 → 50、73。Caveman と常時添付の表現から、結論1〜3行＋末尾3行を基本にし、検証表・手間監査・最終まとめ・承認全文を該当時のみ付ける形へ統一。承認待ちの全文再掲・送信前の全文承認・完了時の実データ検証は維持。 |
| 4. 実装解除 | ONBOARDING.md:1129・1139・1168 → 1124・1134・1163、CLAUDE.md.template:99 → 94。`[LANE-OK]` を削り、`[CLAUDE-IMPL-OK]` だけを記載。セッション限定60分を維持。 |
| 5. 監督の調査 | ONBOARDING.md:146 → 144、CLAUDE.md.template:39 → 38。「user に聞く前の調査は回数無制限」を明示。正本には監督の3ターン制限文なし。hook の場所は下記。 |
| 6. 権限モード | ONBOARDING.md:718・1513 → 713・1508、CLAUDE.md.template:82 → 78。配布既定を `bypassPermissions` と明記し、無人 auto-session で明示する `--permission-mode auto` と区別。 |
| 7. kim 宛報告 | ONBOARDING.md:152・154・161・217–219・781・1293 → 150・152・159・215・776・1288。報告はセッションの最後のメッセージ、無人ジョブは `kim-inbox`。旧 allow 済み通知経路の記述を `notify-kim` の既定の `kim-inbox` 経路に修正。 |
| 8. モデル表記 | ONBOARDING.md:700・704・1066・1085・1131・1195・1694・1785 → 696・700・1061・1080・1126・1190・1689・1780、CLAUDE.md.template:94・103 → 90・98。版番号付きの通称を Opus／Fable に変更。実測証跡のモデルIDは原文のまま。 |

## 調査結果

- **調査制限。** `ONBOARDING.md` と `tools/` を「3ターン」「3 ターン以内」「調査優先」で検索。`tools/cost-routing-gate.mjs:136` の user-facing 以外の注入文に「Fable/Opus 本体は『判定・委譲・結果確認』の 3 ターン以内」が残る。`tools/lib/user-facing.mjs:1` は user に頼む前の調査を回数無制限とする。hook は第2段の対象。
- **実配布値。** `tools/setup.mjs:302` の `convergeAllowRules` が `tools/allow-rules.json:29` の `bypassPermissions` を `tools/allow-rules.mjs:32` で設定。`ORGIAST_KEEP_PERMISSION_MODE=1` なら既存値を保持する。無人起動時の CLI 指定は `tools/auto-session-executor.mjs:155` 付近。
- **通知実装。** `tools/notify-kim.mjs:230–233` は kim 本人および既定宛先を `persistKim` へ渡し、Discord 分岐より前に返る。保存失敗時の spool は同ファイルの `persistKim` にある。明示された非 kim 宛の Discord DM 分岐（237行以降）と webhook フォールバック（265行以降）は残る。`--kim-action-required` はマージ依頼の分類に関する指定で、kim 宛の DM を許可しない。
- **解除 hook の残差。** `tools/claude-impl-approval.mjs:13` は旧 `[LANE-OK]` も受け付ける。第1段の変更は規約の記載まで。
- **AGENTS.md。** `C:/Users/uers/AGENTS.md` の存在は確認した。リポジトリの `tools/`、`scripts/`、`packages/`、`.claude/`、`.agents/`、`.codex/` と、`C:/Users/uers/.claude/tools/`、`C:/Users/uers/.claude/nightly-repo/tools/`、`C:/Users/uers/.codex/` の直下付近で `AGENTS.md` を参照するスクリプトを検索した。Claude→Codex の機械置換と書き込みを行う生成元は特定できなかった。`tools/render-claude-template.mjs` は CLAUDE.md.template の生成元。
- **自動再開の実装。** `tools/stalled-session-resume.mjs:486–520` は `autoResumeAllowed()` が偽の場合に「自動再開は廃止」を記録し、期限切れも `kim-inbox` 通知へ回す。`execute` にも293行のガードがある。`tools/lib/auto-resume-policy.mjs:7–11` が読む `config/auto-resume.json:1` は `enabled: false`。`tools/register-stalled-session-nightly.ps1:27–30` が15分ごとの `--overdue` を登録し、`tools/nightly-batch.ps1:157` は `stalled-session-resume` の移管ログを出す。本段の文書更新だけでは期限付きセッションの自動再開は動かない。

## 変更台帳

置換・削除された行を全文掲載する。変更後の行がない場合は、残っている参照先を明記した。

### ONBOARDING.md

旧 `ONBOARDING.md:68–69`

````text
コスト最適化（ターン・調査・報告削減、委譲率・モデル格下げ）は、
**すべて「user への聞き直しを1回も増やさない」範囲でのみ有効**。満たせないなら削減しない。
````

新 `ONBOARDING.md:68`

````text
コスト最適化（ターン・調査・報告削減、委譲率・モデル格下げ）は、**すべて「user への聞き直しを1回も増やさない」範囲でのみ有効**。満たせないなら削減しない。
````

旧 `ONBOARDING.md:143–144`

````text
**🔴 Claude 側ログの不在は外部システムの不在の証拠ではない。外部の状態は直接照会だけで判定し、未照会は「未確認」と書く。確率付き否定やuserへの検証丸投げは禁止。**
**🔴 「Claude にはできない」「未接続」も断定であり、登録済み経路（memory の reference_* ツール・DWD・GAS・CLI）を当ターンに試した失敗記録だけが証拠。セッションのツール一覧は読込状態であって、接続状態・実行可能性の証拠ではない。未試行のまま user に設定・接続を頼まない。**
````

新 `ONBOARDING.md:142`

````text
**🔴 外部状態は直接照会で判定し、未照会は「未確認」。Claude 側ログの不在やツール一覧（読込状態）は、不在・未接続・実行不能の証拠にならない。「できない」と断定したり user に設定・接続を頼んだりする前に、登録済み経路（memory の reference_* ツール・DWD・GAS・CLI）を当ターンに試し、失敗を記録する。確率付き否定・user への検証丸投げは禁止。**
````

旧 `ONBOARDING.md:146`

````text
**🔴 判断材料は聞かれる前に調べる。費用・プラン・契約・招待・手作業の提案は、2案以上の比較表（月額・得られる枠・手間）＋出典＋推奨を付けて出す。decision-research-gate が差し戻す（2026-10-10 kim 厳命）。**
````

新 `ONBOARDING.md:144`

````text
**🔴 判断材料は聞かれる前に調べる。user に聞く前の調査は回数無制限。費用・プラン・契約・招待・手作業の提案は、2案以上の比較表（月額・得られる枠・手間）＋出典＋推奨を付けて出す。decision-research-gate が差し戻す（2026-10-10 kim 厳命）。**
````

旧 `ONBOARDING.md:152`

````text
**🔴 社内連絡はDiscordで金功勇同席（既存グループDM→kim-PC、無ければBotDM＋写し）。kim宛報告=kim-inbox。PR は作った席が自分で着地させる。pr-land.mjs --title "<題>" --body-file <本文> でbaseへpushし着地させる（通常はautomerge、安全弁パスはCI合格後pr-merge、workflow変更は停止）。権限・鍵・マージを kim-PC に頼まない。不足時は `node tools/access-doctor.mjs --fix`。内部Gmail下書き禁止。**社内DMは承認不要。秘密値非記載。社外全文承認後。
````

新 `ONBOARDING.md:150`

````text
**🔴 社内連絡はDiscordで金功勇同席（既存グループDM→kim-PC、無ければBotDM＋写し）。PR は作った席が自分で着地させる。pr-land.mjs --title "<題>" --body-file <本文> でbaseへpushし着地させる（通常はautomerge、安全弁パスはCI合格後pr-merge、workflow変更は停止）。権限・鍵・マージを kim-PC に頼まない。不足時は `node tools/access-doctor.mjs --fix`。内部Gmail下書き禁止。**社内DMは承認不要。秘密値非記載。社外全文承認後。
````

旧 `ONBOARDING.md:154`

````text
**🔴 kim 宛 Discord DM は全廃・例外なし（緊急を含む・全PC全アカウント）。kim-inbox（~/.claude/kim-inbox、node tools/kim-inbox.mjs）へ積みセッションで回収。ask は --answer まで毎プロンプト再提示、info は伝えたら --seen。クローズを止めず台帳を次セッションへ引き継ぐ。Discord MCP 直接送信はゲートが拒否し、旧 config/kim-discord-allowlist.json のカテゴリも廃止。詳細 docs/kim-inbox.md。**
````

新 `ONBOARDING.md:152`

````text
**🔴 無人ジョブの kim 宛報告は kim-inbox（~/.claude/kim-inbox、node tools/kim-inbox.mjs）に積み、セッションで回収する。kim 宛 Discord DM は全廃・例外なし（緊急を含む・全PC全アカウント）。ask は --answer まで毎プロンプト再提示、info は伝えたら --seen。クローズを止めず台帳を次セッションへ引き継ぐ。Discord MCP 直接送信はゲートが拒否し、旧 config/kim-discord-allowlist.json のカテゴリも廃止。詳細 docs/kim-inbox.md。**
````

旧 `ONBOARDING.md:161`

````text
送信ゲート `tools/lib/kim-dm-policy.mjs` が `notify-kim` / `discord-dm` のマージ依頼を止める。kim の操作が本当に必要な例外だけ `--kim-action-required` を付ける。
````

新 `ONBOARDING.md:159`

````text
`tools/lib/kim-dm-policy.mjs` が `notify-kim` / `discord-dm` のマージ依頼を止める。kim の操作が本当に必要な場合だけ `--kim-action-required` を付け、kim 宛 Discord DM の禁止は維持する。
````

旧 `ONBOARDING.md:217–219`

````text
**🔴 kim が読むのは「本当に最後のメッセージ」（Stop ゲートの書き直しが終わった最後の1通）だけ。そこに【最終まとめ】（①報告 ②kim の確認事項＝全文 ③kim がやること）を全部載せ、途中に置いて遡らせない。途中のメッセージを参照させない。③で使うファイルは Drive の URL を同じ行に毎回書く。書き直しでは経緯を繰り返さない（2026-10-30 kim 厳命・全PC全アカウント）。**

**🔴 応答末尾は必ず3行「次に kim がすること／この後の自動進行／このセッション」。完了結論は1〜3行、検証表と必要な確認全文を【最終まとめ】にそろえ、その直後を3行フッターにする。承認ブロック【kim 確認用の全文】は最後の節に置き、③・手間監査・恒久策はその前に書く。**
````

新 `ONBOARDING.md:215`

````text
**🔴 kim への報告は Stop ゲートの書き直し後、セッションの最後のメッセージに自己完結させる。結論1〜3行＋末尾3行「次に kim がすること／この後の自動進行／このセッション」が基本。検証表・手間監査・【最終まとめ】・【kim 確認用の全文】は該当時のみ付ける。【最終まとめ】には報告・確認事項の全文・kim の操作を載せ、操作に使う Drive URL は同じ行に書く。承認全文はフッター直前に置き、操作・手間監査・恒久策はその前に書く。過去の応答を参照させない。**
````

旧 `ONBOARDING.md:221`

````text
書き直し（Stop hook feedback 後）は「指摘分の修正＋【最終まとめ】＋末尾3行」だけにする。
````

新 `ONBOARDING.md:217`

````text
書き直し（Stop hook feedback 後）では経緯を繰り返さず、指摘分の修正・該当する【最終まとめ】・末尾3行だけにする。
````

旧 `ONBOARDING.md:678`

````text
**🔴 トークン効率: 出力は Caveman（output-styles/caveman.md、前置きなし・完了結論1〜3行。必要な検証表・全文・末尾3行は省略しない）。CLAUDE.md は恒久ルールのみ、上部ほど静的にし、進行中タスク・今日の数字・障害を書かない。モデル切替を乱発しない。探索は Explore/general-purpose に「結果200字以内・コード本体なし」で委譲。実装は Codex、設計/横断調査/複数仮説は Opus/Fable（§1.16 の制約）、軽い確認・締めは Sonnet/Haiku、迷ったら Opus。**
````

新 `ONBOARDING.md:674`

````text
**🔴 CLAUDE.md は恒久ルールのみ。静的な内容を上部に置き、進行中タスク・今日の数字・障害は載せない。報告は前置きなしで §1.1 に従う。モデル切替は乱発しない。探索は Agent ツールの Explore/general-purpose に「結果200字以内・コード本体なし」で委譲。実装は Codex、設計・横断調査・複数仮説は Opus/Fable（§1.16）、軽い確認・締めは Sonnet/Haiku。**
````

旧 `ONBOARDING.md:700`

````text
  - **指揮官・判断・設計 → Opus5**（GA・$5/$25・Opus4.8の2倍性能で同単価。アーキ設計/根本原因分析/横断一貫性/経営判断/タスク分解・レビュー）
````

新 `ONBOARDING.md:696`

````text
  - **指揮官・判断・設計 → Opus**（アーキ設計/根本原因分析/横断一貫性/経営判断/タスク分解・レビュー）
````

単価と性能比較は版に固有のため現行ルールから外し、この旧文に記録。担当範囲は新文に保持。

旧 `ONBOARDING.md:706`

````text
- 重い探索はAgentツール(Explore/general-purpose)に委譲し「結果を200字以内・コード本体は含めない」と指定
````

探索の委譲先・200字上限・コード本体を含めない条件は ONBOARDING.md:674 に統合。

旧 `ONBOARDING.md:718`

````text
permission mode の既定は `bypassPermissions`（kim 2026-09-17 決定）。安全は deny リスト（allow-rules.json）と社内 hook の2層で担保する。
````

新 `ONBOARDING.md:713`

````text
`setup --converge` が配布する `permissions.defaultMode` は `bypassPermissions`（kim 2026-09-17 決定）。安全は deny リスト（allow-rules.json）と社内 hook の2層で担保する。
````

旧 `ONBOARDING.md:733`

````text
**自動再開は廃止（kim 2026-11-14）。** 止まった・待ち状態のセッションを Claude で自動的に --resume しない。期限切れ・停滞は kim-inbox 通知のみ。再有効化は config/auto-resume.json の enabled を kim 承認で変更する。
````

新 `ONBOARDING.md:728`

````text
**🔴 止まったセッションはタイトル頭に【MM/DD/HH:MMまで】の期限が付いたものだけ、期限を過ぎたら自動再開する。それ以外は自動再開しない。**
````

旧停止設定と通知-only 分岐は上の調査結果に記録。規約は承認済みの期限条件に更新。

旧 `ONBOARDING.md:760`

````text
  - `まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）`: 作業継続中。何日の何時まで待つかを必ず入れる（例: `まだ閉じない（作業中・2026-11-02 23:59 まで待つ）`）。期限は待っている相手の作業や自動チェックの期限に合わせ、過ぎたら新しい期限に書き換えるか、確認せず自分で /session-close を実行する（2026-10-27 nishi 指示。next-action-gate が SESSION-OPEN-NO-DEADLINE / SESSION-OPEN-DEADLINE-PAST で検査）。 自動再開は廃止。`OrgiastWaitDeadlineResume`（15分ごと）は期限切れを kim-inbox に1回だけ通知する。
````

新 `ONBOARDING.md:755`

````text
  - `まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）`: 作業継続中。何日の何時まで待つかを必ず入れる（例: `まだ閉じない（作業中・2026-11-02 23:59 まで待つ）`）。期限は待っている相手の作業や自動チェックの期限に合わせ、過ぎたら新しい期限に書き換えるか、確認せず自分で /session-close を実行する（2026-10-27 nishi 指示。next-action-gate が SESSION-OPEN-NO-DEADLINE / SESSION-OPEN-DEADLINE-PAST で検査）。 自動再開の対象は本節冒頭のタイトル期限規定に従う。
````

旧タスクの15分周期は tools/register-stalled-session-nightly.ps1:27–30。通知のみの現行コードは上の調査結果に記録。

旧 `ONBOARDING.md:781`

````text
kim 宛の定期ダイジェスト（朝/夜/urgent）・完了通知・配送異常の警告はすべて kim-inbox へ保存する。Discord DM は全廃・例外なし（緊急を含む、kim 2026-11-06）。古いローカル許可リストも適用しない。
````

新 `ONBOARDING.md:776`

````text
定期ダイジェスト（朝/夜/urgent）・完了通知・配送異常の警告は無人ジョブの報告として §1.1 に従い kim-inbox に保存する。
````

Discord DM 禁止と許可リスト廃止は ONBOARDING.md:152 に集約。

旧 `ONBOARDING.md:783`

````text
**「この後の自動進行: <内容>」の宣言は台帳に記録され、止まれば自動で拾われる（2026-10-14 追加）**。Stop hook `tools/auto-progress-ledger.mjs` が宣言（「なし」以外）を `~/.claude/auto-progress-ledger.jsonl` に記録する（同一セッションは最新で置換）。各PCの定期タスク `OrgiastAutoProgressWatch` が毎時台帳を巡回し、宣言から1時間以降のものを判定する。stalled は自動再開せず、手動再開の案内を kim-inbox に1回だけ通知する。全PCが1日2回（朝枠＝定時報告・夕枠＝変化分のみ）自PC分を kim-inbox に積む。朝枠は変化0件でも進行中・判断待ち・完了を全件名前付きで送る。夕枠・枠外は変化分のみ。check の引き継ぎ: 新しい約束行に check が無く、直前の open 行に期限が未来の check があれば引き継ぐ（check が superseded で消える再発防止）。だから宣言は「実際に自動で進む内容」だけ書く。API エラー（利用上限など）で返答できずに終わった依頼も、毎時の巡回が transcript から見つけて台帳へ起票し、kim-inbox に手動再開の案内を通知する。Sheet 側の追加手順は `docs/auto-progress-gas-patch.gs.txt`。
````

新 `ONBOARDING.md:778`

````text
**「この後の自動進行: <内容>」の宣言は台帳に記録され、止まれば自動で拾われる（2026-10-14 追加）**。Stop hook `tools/auto-progress-ledger.mjs` が宣言（「なし」以外）を `~/.claude/auto-progress-ledger.jsonl` に記録する（同一セッションは最新で置換）。各PCの定期タスク `OrgiastAutoProgressWatch` が毎時台帳を巡回し、宣言から1時間以降のものを判定する。この巡回では stalled の手動再開案内を kim-inbox に1回だけ通知する。タイトル期限による自動再開の対象は §1.15 に従う。全PCが1日2回（朝枠＝定時報告・夕枠＝変化分のみ）自PC分を kim-inbox に積む。朝枠は変化0件でも進行中・判断待ち・完了を全件名前付きで送る。夕枠・枠外は変化分のみ。check の引き継ぎ: 新しい約束行に check が無く、直前の open 行に期限が未来の check があれば引き継ぐ（check が superseded で消える再発防止）。だから宣言は「実際に自動で進む内容」だけ書く。API エラー（利用上限など）で返答できずに終わった依頼も、毎時の巡回が transcript から見つけて台帳へ起票し、kim-inbox に手動再開の案内を通知する。Sheet 側の追加手順は `docs/auto-progress-gas-patch.gs.txt`。
````

旧 `ONBOARDING.md:1066`

````text
**例外は hook が自動で扱う**: user が「Fable5で〜」と明示指定したプロンプトを UserPromptSubmit が検知して 60分・同一セッション限りの許可トークン（`~/.claude/fable-allow.json`）を発行し、その間だけ deny を通す（時間経過とセッション変更で自動失効。「Fable5は使うな」等の否定文脈では発行しない）。user 側の手作業・設定変更は不要。必須 hook の欠落は SessionStart の `hook-selfcheck` が自動修復する。
````

新 `ONBOARDING.md:1061`

````text
**例外は hook が自動で扱う**: user が「Fableで〜」と明示指定したプロンプトを UserPromptSubmit が検知して 60分・同一セッション限りの許可トークン（`~/.claude/fable-allow.json`）を発行し、その間だけ deny を通す（時間経過とセッション変更で自動失効。「Fableは使うな」等の否定文脈では発行しない）。user 側の手作業・設定変更は不要。必須 hook の欠落は SessionStart の `hook-selfcheck` が自動修復する。
````

旧 `ONBOARDING.md:1085`

````text
**🔴 費用対効果は①既存自動化/ローカル（消費ゼロ）→②Codex（コード・定額）／Manus（Web調査・エンリッチ・専用枠）→③従量は最小モデル（分類Haiku→量産Sonnet→Opus5は品質差実測・正当化）→④大量消費は着手前に費用見込み1行。未導入は自分でinstallする。Fableは監督のみ、実装/量産/分類は禁止。実装の切替は §1.18 の非Claude全滅時停止・費用提示・kim承認を守り、userの往復・開発品質を犠牲にしない（§1.17.1）。**
````

新 `ONBOARDING.md:1080`

````text
**🔴 費用対効果は①既存自動化/ローカル（消費ゼロ）→②Codex（コード・定額）／Manus（Web調査・エンリッチ・専用枠）→③従量は最小モデル（分類Haiku→量産Sonnet→Opusは品質差実測・正当化）→④大量消費は着手前に費用見込み1行。未導入は自分でinstallする。Fableは監督のみ、実装/量産/分類は禁止。実装の切替は §1.18 の非Claude全滅時停止・費用提示・kim承認を守り、userの往復・開発品質を犠牲にしない（§1.17.1）。**
````

旧 `ONBOARDING.md:1129`

````text
**🔴 Claudeだけで実装しない・従量課金でClaude Codeを動かさない。直接実装・大きなインラインプログラム・実装サブエージェントはモデルを問わずdeny。解除はuserの [CLAUDE-IMPL-OK]（または [LANE-OK]）のセッション限定60分だけ、overrideファイル・自動解除は廃止。APIキー/Consoleログインは api-billing-guard が全ツールを止める。全アカウントGmail領収書を毎日集計（§2.8.5）、通知は §1.1 の許可リスト規定。必須hook欠落は hook-selfcheck が修復。**
````

新 `ONBOARDING.md:1124`

````text
**🔴 Claudeだけで実装しない・従量課金でClaude Codeを動かさない。直接実装・大きなインラインプログラム・実装サブエージェントはモデルを問わずdeny。解除はuserの [CLAUDE-IMPL-OK] によるセッション限定60分だけ、overrideファイル・自動解除は廃止。APIキー/Consoleログインは api-billing-guard が全ツールを止める。全アカウントGmail領収書を毎日集計（§2.8.5）、kim への報告経路は §1.1 に従う。必須hook欠落は hook-selfcheck が修復。**
````

旧 `ONBOARDING.md:1131`

````text
**方針（2026-08-06 管理者kim決定・既定変更）: 既定の"監督(main loop)"は Opus。監督は最小限しか動かず、実働を Codex/Sonnet/Gemini にうまく流すことでコストを下げ品質を上げる。**（旧「既定Sonnet」から変更。真のコストレバーは Opus/Sonnet の別ではなく「監督が実装を自分で手打ちせず委譲しているか」＝この長大セッションで Opus 4.8 が委譲せず直接編集・pushを挽いたのが高騰の主因＝反面教師。）
````

新 `ONBOARDING.md:1126`

````text
**方針（2026-08-06 管理者kim決定・既定変更）: 既定の"監督(main loop)"は Opus。監督は最小限しか動かず、実働を Codex/Sonnet/Gemini にうまく流すことでコストを下げ品質を上げる。**（旧「既定Sonnet」から変更。真のコストレバーは Opus/Sonnet の別ではなく「監督が実装を自分で手打ちせず委譲しているか」＝この長大セッションで Opus が委譲せず直接編集・pushを挽いたのが高騰の主因＝反面教師。）
````

旧 `ONBOARDING.md:1139`

````text
- **解除できるのは user のプロンプトだけ**: user が同じ指示に `[CLAUDE-IMPL-OK]`（または `[LANE-OK]`）と書いたとき、UserPromptSubmit の `claude-impl-approval` が **そのセッション・60分限り**の許可を発行する。`~/.claude/cost-enforce-override` ファイル・委譲率の観測・Codex クールダウン中の自動解除は **廃止**（Claude 自身が作れる抜け道は全部塞ぐ）。Codex が上限中でも `codex-do` は deepseek/glm/gemini へ内蔵フォールバックするので、そのまま委譲する。全滅なら実装を止めて費用見込みを kim に提示し、承認マーカーを待つ。
````

新 `ONBOARDING.md:1134`

````text
- **解除できるのは user のプロンプトだけ**: user が同じ指示に `[CLAUDE-IMPL-OK]` と書いたとき、UserPromptSubmit の `claude-impl-approval` が **そのセッション・60分限り**の許可を発行する。`~/.claude/cost-enforce-override` ファイル・委譲率の観測・Codex クールダウン中の自動解除は **廃止**（Claude 自身が作れる抜け道は全部塞ぐ）。Codex が上限中でも `codex-do` は deepseek/glm/gemini へ内蔵フォールバックするので、そのまま委譲する。全滅なら実装を止めて費用見込みを kim に提示し、承認マーカーを待つ。
````

旧 `ONBOARDING.md:1168`

````text
Fable/Opus本体の直接ツール実行は1ターン4回で警告、8回で停止（lane-guard）。例外はuser指示の `[LANE-OK]`。非Claude実装レーンが全滅してもSonnetへ自動切替せず、§1.18の順序で停止・費用提示・kim承認を守る。verify / bulkのSonnet経路を実装の代用にしない。MCPコネクタ操作は最初からSonnetサブエージェントへ渡してよいが、アプリ実装は含めない（2026-09-10承認、2026-09-15実装fallback改定）。
````

新 `ONBOARDING.md:1163`

````text
Fable/Opus本体の直接ツール実行は1ターン4回で警告、8回で停止（lane-guard）。例外は user 指示の `[CLAUDE-IMPL-OK]`。非Claude実装レーンが全滅してもSonnetへ自動切替せず、§1.18の順序で停止・費用提示・kim承認を守る。verify / bulkのSonnet経路を実装の代用にしない。MCPコネクタ操作は最初からSonnetサブエージェントへ渡してよいが、アプリ実装は含めない（2026-09-10承認、2026-09-15実装fallback改定）。
````

旧 `ONBOARDING.md:1195`

````text
- Fable 5.1（および Opus）の担当は設計・タスク分解・指示・レビュー・検証だけ。実装は Codex、
````

新 `ONBOARDING.md:1190`

````text
- Fable（および Opus）の担当は設計・タスク分解・指示・レビュー・検証だけ。実装は Codex、
````

旧 `ONBOARDING.md:1293`

````text
5. クレデンシャルはkeyserveのみ。マージは `tools/pr-merge.mjs`、通知は `tools/notify-kim.mjs` とし、いずれもallow済みの経路だけを使う。
````

新 `ONBOARDING.md:1288`

````text
5. クレデンシャルはkeyserveのみ。マージは allow 済みの `tools/pr-merge.mjs` を使う。kim への報告はセッションの最後のメッセージに載せ、無人ジョブでは `tools/notify-kim.mjs` の既定の kim-inbox 経路を使う。
````

旧 `ONBOARDING.md:1513`

````text
- `--permission-mode auto` を**明示的に渡す**（`acceptEdits` は Bash を承認待ちで止めるため不可。以前は settings.json の既定 `auto` を継承する設計だったが、2026-09-17 に実機で `permissions.defaultMode` が未設定と判明したため、継承に頼らず明示するよう修正した）。
````

新 `ONBOARDING.md:1508`

````text
- 無人 auto-session は `--permission-mode auto` を明示し、配布既定の `bypassPermissions` を継承しない。`acceptEdits` は Bash を承認待ちで止めるため使わない。
````

旧 `ONBOARDING.md:1694`

````text
3.0.2: 各PCが当月Claude Code概算コスト（PC名・$合計・モデル別内訳のみ、**会話内容は送らない**）をDiscordに日次自己申告。当月$150超⚠️/$300超🚨・Fable5検出🚨のアラート付き。中央のAPI課金監視(GH Actions日次)と合わせて「組織合計＋per-PC」の二層監査になる。
````

新 `ONBOARDING.md:1689`

````text
3.0.2: 各PCが当月Claude Code概算コスト（PC名・$合計・モデル別内訳のみ、**会話内容は送らない**）をDiscordに日次自己申告。当月$150超⚠️/$300超🚨・Fable検出🚨のアラート付き。中央のAPI課金監視(GH Actions日次)と合わせて「組織合計＋per-PC」の二層監査になる。
````

旧 `ONBOARDING.md:1785`

````text
**経緯**: 2026-07-13 kim 指示「Fable5 はもう使わないように。別料金がかかるので」→ 2026-08-06 スコープを全用途へ拡大 → 2026-09-03 kim の問い「定額制の中に入っていないってことかな」を受けて実測し、前提が誤りと判明して現行ルールへ改定。
````

新 `ONBOARDING.md:1780`

````text
**経緯**: 2026-07-13 kim 指示「Fable はもう使わないように。別料金がかかるので」→ 2026-08-06 スコープを全用途へ拡大 → 2026-09-03 kim の問い「定額制の中に入っていないってことかな」を受けて実測し、前提が誤りと判明して現行ルールへ改定。
````

### CLAUDE.md.template

旧 `CLAUDE.md.template:21`

````text
**社員・他PCに状況を聞く前も、user に聞く前と同じく自分で照会する（応募・メール・シート・Discord は Claude が読める）。
````

新 `CLAUDE.md.template:21`

````text
**社員・他PCに状況を聞く前も、user に聞く前と同じく自分で照会する（応募・メール・シート・Discord は Claude が読める）。**
````

太字と最初の文は完全な形で表示し、詳細は ONBOARDING.md:51 参照。

旧 `CLAUDE.md.template:26`

````text
コスト最適化（ターン・調査・報告削減、委譲率・モデル格下げ）は、
````

新 `CLAUDE.md.template:26`

````text
コスト最適化（ターン・調査・報告削減、委譲率・モデル格下げ）は、**すべて「user への聞き直しを1回も増やさない」範囲でのみ有効**。
````

切れていた文を ONBOARDING.md:68 の続きのある文から生成。

旧 `CLAUDE.md.template:37–41`

````text
**🔴 Claude 側ログの不在は外部システムの不在の証拠ではない。外部の状態は直接照会だけで判定し、未照会は「未確認」と書く。確率付き否定やuserへの検証丸投げは禁止。**
**🔴 「Claude にはできない」「未接続」も断定であり、登録済み経路（memory の reference_* ツール・DWD・GAS・CLI）を当ターンに試した失敗記録だけが証拠。セッションのツール一覧は読込状態であって、接続状態・実行可能性の証拠ではない。未試行のまま user に設定・接続を頼まない。**
**🔴 判断材料は聞かれる前に調べる。費用・プラン・契約・招待・手作業の提案は、2案以上の比較表（月額・得られる枠・手間）＋出典＋推奨を付けて出す。decision-research-gate が差し戻す。**
**🔴 社内連絡はDiscordで金功勇同席（既存グループDM→kim-PC、無ければBotDM＋写し）。kim宛報告=kim-inbox。PR は作った席が自分で着地させる。pr-land.mjs --title "<題>" --body-file <本文> でbaseへpushし着地させる（通常はautomerge、安全弁パスはCI合格後pr-merge、workflow変更は停止）。権限・鍵・マージを kim-PC に頼まない。不足時は `node tools/access-doctor.mjs --fix`。内部Gmail下書き禁止。**社内DMは承認不要。秘密値非記載。社外全文承認後。
**🔴 kim 宛 Discord DM は全廃・例外なし（緊急を含む・全PC全アカウント）。kim-inbox（~/.claude/kim-inbox、node tools/kim-inbox.mjs）へ積みセッションで回収。ask は --answer まで毎プロンプト再提示、info は伝えたら --seen。クローズを止めず台帳を次セッションへ引き継ぐ。Discord MCP 直接送信はゲートが拒否し、旧 config/kim-discord-allowlist.json のカテゴリも廃止。詳細 docs/kim-inbox.md。**
````

新 `CLAUDE.md.template:37–40`

````text
**🔴 外部状態は直接照会で判定し、未照会は「未確認」。Claude 側ログの不在やツール一覧（読込状態）は、不在・未接続・実行不能の証拠にならない。「できない」と断定したり user に設定・接続を頼んだりする前に、登録済み経路（memory の reference_* ツール・DWD・GAS・CLI）を当ターンに試し、失敗を記録する。確率付き否定・user への検証丸投げは禁止。**
**🔴 判断材料は聞かれる前に調べる。user に聞く前の調査は回数無制限。費用・プラン・契約・招待・手作業の提案は、2案以上の比較表（月額・得られる枠・手間）＋出典＋推奨を付けて出す。decision-research-gate が差し戻す。**
**🔴 社内連絡はDiscordで金功勇同席（既存グループDM→kim-PC、無ければBotDM＋写し）。PR は作った席が自分で着地させる。pr-land.mjs --title "<題>" --body-file <本文> でbaseへpushし着地させる（通常はautomerge、安全弁パスはCI合格後pr-merge、workflow変更は停止）。権限・鍵・マージを kim-PC に頼まない。不足時は `node tools/access-doctor.mjs --fix`。内部Gmail下書き禁止。**社内DMは承認不要。秘密値非記載。社外全文承認後。
**🔴 無人ジョブの kim 宛報告は kim-inbox（~/.claude/kim-inbox、node tools/kim-inbox.mjs）に積み、セッションで回収する。kim 宛 Discord DM は全廃・例外なし（緊急を含む・全PC全アカウント）。ask は --answer まで毎プロンプト再提示、info は伝えたら --seen。クローズを止めず台帳を次セッションへ引き継ぐ。Discord MCP 直接送信はゲートが拒否し、旧 config/kim-discord-allowlist.json のカテゴリも廃止。詳細 docs/kim-inbox.md。**
````

旧 `CLAUDE.md.template:51–52`

````text
**🔴 kim が読むのは「本当に最後のメッセージ」（Stop ゲートの書き直しが終わった最後の1通）だけ。そこに【最終まとめ】（①報告 ②kim の確認事項＝全文 ③kim がやること）を全部載せ、途中に置いて遡らせない。途中のメッセージを参照させない。③で使うファイルは Drive の URL を同じ行に毎回書く。書き直しでは経緯を繰り返さない。**
**🔴 応答末尾は必ず3行「次に kim がすること／この後の自動進行／このセッション」。完了結論は1〜3行、検証表と必要な確認全文を【最終まとめ】にそろえ、その直後を3行フッターにする。承認ブロック【kim 確認用の全文】は最後の節に置き、③・手間監査・恒久策はその前に書く。**
````

新 `CLAUDE.md.template:50`

````text
**🔴 kim への報告は Stop ゲートの書き直し後、セッションの最後のメッセージに自己完結させる。結論1〜3行＋末尾3行「次に kim がすること／この後の自動進行／このセッション」が基本。検証表・手間監査・【最終まとめ】・【kim 確認用の全文】は該当時のみ付ける。【最終まとめ】には報告・確認事項の全文・kim の操作を載せ、操作に使う Drive URL は同じ行に書く。承認全文はフッター直前に置き、操作・手間監査・恒久策はその前に書く。過去の応答を参照させない。**
````

旧 `CLAUDE.md.template:58`

````text
**1.3 GAS（Google Apps Script）は clasp + GitHub 統一**
````

ONBOARDING.md:357 とテンプレート54–55行の §1.3 案内・GAS の必須ルールに残る。

旧 `CLAUDE.md.template:76–77`

````text
**🔴 トークン効率: 出力は Caveman（output-styles/caveman.md、前置きなし・完了結論1〜3行。必要な検証表・全文・末尾3行は省略しない）。CLAUDE.md は恒久ルールのみ、上部ほど静的にし、進行中タスク・今日の数字・障害を書かない。モデル切替を乱発しない。探索は Explore/general-purpose に「結果200字以内・コード本体なし」で委譲。実装は Codex、設計/横断調査/複数仮説は Opus/Fable（§1.16 の制約）、軽い確認・締めは Sonnet/Haiku、迷ったら Opus。**
**1.13 トークン効率（出力・入力キャッシュ・サブエージェント）**
````

新 `CLAUDE.md.template:73`

````text
**🔴 CLAUDE.md は恒久ルールのみ。静的な内容を上部に置き、進行中タスク・今日の数字・障害は載せない。報告は前置きなしで §1.1 に従う。モデル切替は乱発しない。探索は Agent ツールの Explore/general-purpose に「結果200字以内・コード本体なし」で委譲。実装は Codex、設計・横断調査・複数仮説は Opus/Fable（§1.16）、軽い確認・締めは Sonnet/Haiku。**
````

旧77行の見出しは ONBOARDING.md:676 とテンプレート71行に残る。迷った場合のモデルはテンプレート72行、報告形式は50行。

旧 `CLAUDE.md.template:82`

````text
permission mode の既定は `bypassPermissions`。
````

新 `CLAUDE.md.template:78`

````text
`setup --converge` が配布する `permissions.defaultMode` は `bypassPermissions`（kim 2026-09-17 決定）。安全は deny リスト（allow-rules.json）と社内 hook の2層で担保する。
````

旧 `CLAUDE.md.template:84`

````text
**自動再開は廃止。
````

新 `CLAUDE.md.template:80`

````text
**🔴 止まったセッションはタイトル頭に【MM/DD/HH:MMまで】の期限が付いたものだけ、期限を過ぎたら自動再開する。それ以外は自動再開しない。**
````

未閉鎖の強調と旧方針を、ONBOARDING.md:728 の新ルールで置換。

旧 `CLAUDE.md.template:94`

````text
**🔴 費用対効果は①既存自動化/ローカル（消費ゼロ）→②Codex（コード・定額）／Manus（Web調査・エンリッチ・専用枠）→③従量は最小モデル（分類Haiku→量産Sonnet→Opus5は品質差実測・正当化）→④大量消費は着手前に費用見込み1行。未導入は自分でinstallする。Fableは監督のみ、実装/量産/分類は禁止。実装の切替は §1.18 の非Claude全滅時停止・費用提示・kim承認を守り、userの往復・開発品質を犠牲にしない（§1.17.1）。**
````

新 `CLAUDE.md.template:90`

````text
**🔴 費用対効果は①既存自動化/ローカル（消費ゼロ）→②Codex（コード・定額）／Manus（Web調査・エンリッチ・専用枠）→③従量は最小モデル（分類Haiku→量産Sonnet→Opusは品質差実測・正当化）→④大量消費は着手前に費用見込み1行。未導入は自分でinstallする。Fableは監督のみ、実装/量産/分類は禁止。実装の切替は §1.18 の非Claude全滅時停止・費用提示・kim承認を守り、userの往復・開発品質を犠牲にしない（§1.17.1）。**
````

旧 `CLAUDE.md.template:98–99`

````text
**1.18 監督(Opus)は最小限だけ動き、実働はCodex/Sonnet/Geminiに委譲する**
**🔴 Claudeだけで実装しない・従量課金でClaude Codeを動かさない。直接実装・大きなインラインプログラム・実装サブエージェントはモデルを問わずdeny。解除はuserの [CLAUDE-IMPL-OK]（または [LANE-OK]）のセッション限定60分だけ、overrideファイル・自動解除は廃止。APIキー/Consoleログインは api-billing-guard が全ツールを止める。全アカウントGmail領収書を毎日集計（§2.8.5）、通知は §1.1 の許可リスト規定。必須hook欠落は hook-selfcheck が修復。**
````

新 `CLAUDE.md.template:94`

````text
**🔴 Claudeだけで実装しない・従量課金でClaude Codeを動かさない。直接実装・大きなインラインプログラム・実装サブエージェントはモデルを問わずdeny。解除はuserの [CLAUDE-IMPL-OK] によるセッション限定60分だけ、overrideファイル・自動解除は廃止。APIキー/Consoleログインは api-billing-guard が全ツールを止める。全アカウントGmail領収書を毎日集計（§2.8.5）、kim への報告経路は §1.1 に従う。必須hook欠落は hook-selfcheck が修復。**
````

旧98行の見出しは ONBOARDING.md:1122。担当モデルと委譲先は同1126行以降に残る。

旧 `CLAUDE.md.template:103`

````text
- Fable 5.1（および Opus）の担当は設計・タスク分解・指示・レビュー・検証だけ。
````

新 `CLAUDE.md.template:98`

````text
- Fable（および Opus）の担当は設計・タスク分解・指示・レビュー・検証だけ。
````

旧 `CLAUDE.md.template:121`

````text
**2.1 経営データに無い属性をハルシネーションしない**
````

ONBOARDING.md:1356 の見出しと、テンプレート113行の §2.1 案内に残る。

旧 `CLAUDE.md.template:130`

````text
#### 制作・営業ナレッジ（全アカウント・全PC）
````

ONBOARDING.md:1557 に見出し、同節に本文。配布時のナレッジ参照先はテンプレート127行の固定リンク。

## 検証と作業ツリーの状態

- `node --test tools/onboarding-sync.test.mjs` は65件合格。追加の索引回帰3件とサイズ上限検査を含む。
- 索引生成・配布テンプレートの再現・既配布設定の移行・Discord 配送を含む関連テスト5ファイルは110件合格。Discord のログ出力先は `ORGIAST_HOME` で一時ディレクトリを指定した。
- `node tools/render-claude-template.mjs --check` でテンプレートの再現を確認。
- ブランチは `rules-slim-20261120`。リンク先の Git メタデータが読み取り専用で、`git add` が `index.lock` を作れなかった。変更と本報告書は作業ツリーにある。
