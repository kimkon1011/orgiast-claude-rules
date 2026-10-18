# fleet 依頼の追跡

TASK_ID: fleet-chase-A-ledger-and-escalation (2026-10-18)、担当: Codex。
TASK_ID: fleet-chase-B-rule-compliance-rollout (2026-10-18)、担当: Codex。
送って終わりにせず、完了の証拠を回収するまでkim-PCで追跡する。
**期限切れは完了ではない。** GASやinboxのstatusを台帳から書き換えない。

## 台帳と実行

`~/.claude/fleet-chase/ledger.json` は version 1、itemsはitemIdをキーとする。
原本、再送ID、状態、試行履歴、次回時刻、証拠、保留理由を保持する。
本文は秘密値を除去して保存する。ロックとtmp→renameで排他・原子的更新を行う。
`node tools/fleet-chase.mjs` は取込→確認→追跡→自動消化→ダイジェストを実行。
`--ingest / --check / --chase / --work / --digest` で工程を個別実行できる。
`--status` は一覧、`--json` はJSON。`--dry-run --status` は取込・予定をメモリ内で計算。
dry-runは照会だけを行い、台帳・ログ・ロック・通知・LLMを一切書込/実行しない。
全入口は `resolveFleetLabel(home)==='kim-PC'` に限定する。
初回取込で7日より古い依頼はstale（過去の未完了を一斉再送しない）。件数だけを日次通知し、自動蘇生しない。
同報/自分宛の送信、回答・報告返信不要、配布通知、返信メールは追跡対象外。

## 完了とブロッカー

送信はGASのmail-get（原本と追跡メール、古い確認順に最大20件）がdoneで、
resultBodyが権限不足/判断待ち/実行失敗などのブロッカーでなければ完了。
ブロッカーならblockedにし、kim-PCの「ブロッカー解消」受信債務を生成する。
受信はinboxのdoneを確認。判断依頼は対応decisionの回答完了と返信記録も必要。
受領確認やbatched（判断の提示済み）では完了にしない。
自動消化は最終行CHASE_RESULT: doneとinbox完了を両方確認する。
失敗・timeout・判断待ちはopenに残し、古いブロッカー返信を完了証拠にしない。

| 段階 | 条件・対応 | 間隔 |
|---|---|---|
| L0 | 有効期限の20%前以降、未読かつ最終pollが24h以内なら原文再送 | 72h |
| L1 | poll停止24h超なら担当者に起動依頼DM。宛先/時刻不明は集約通知 | 24h |
| L2 | seen後24h未完了なら状況・証拠・理由を催促 | 24h |
| L3 | seen後48h未完了をkimの日次通知に掲載し、催促を継続 | 72h |

execのマーカーは解析互換のため本文最先頭を保ち、その直後に追跡見出しを置く。
本文上限20000字を超える再送は原文を切らず、chase-errorとして記録する。
全関連IDの初回状態照会が済むまでは催促を待つ（取込直後の完了済み依頼への誤再送を防止）。
送付失敗時は保存済みの同じID/本文で再試行し、通信結果不明による二重送付を防ぐ。
担当者がkim本人のPCは個別DMせず集約。日次通知は09:00 JST以降、DM成功時だけ記録。
通知は上位8件と件数。notifyKimのLLM文章変換は無効化する。

## kimの操作

- 取り下げ: `node tools/fleet-chase.mjs --cancel <itemId> --reason "不要になった理由"`
- 保留: `node tools/fleet-chase.mjs --defer <itemId> --until +3d --reason "待つ理由"`（ISO時刻も可）
- 蘇生: `node tools/fleet-chase.mjs --revive <itemId>`（staleだけ）

保留中も表示し、期限までは催促・自動消化しない。明示取り下げだけが証拠なしで閉じる操作。

## 自動消化・セッション表示

promptオプトイン済みのkim-PCだけで、判断依頼以外のopen受信を最大2件、各20分実行。
同じ債務は6h間隔、最大5回。失敗上限後もhookで表示し、日次通知に残す。
他PCの設定変更・権限付与・鍵配布・外部送信を禁止し、必要な判断はpending-decisionsへ。
SessionStart/UserPromptSubmitは受信最古3件、送信L2以上2件を1200字以内で表示。
inbox hookが同セッションで提示済みの受信は省き、同内容は30分抑止する。
hookはネットワーク無し、台帳/inboxは読むだけ（セッション抑止マーカーのみ保存）。

## 配布と役割分担

convergeのtask:fleet-chaseが `register-fleet-chase.mjs` を呼ぶ。
OrgiastFleetChaseは30分周期、50分上限、重複起動禁止。kim-PC以外では登録しない。
既存watchdogは未配達SLA、convergence-watchはルール配布収束、chaseは依頼の完了回収を担う。
本実装ではpush/merge/GAS変更/実タスク登録を行わない。

## ルール遵守の回収

各PCのpollは日次ワーカーを起動し、7日間の監査を子プロセスで実行（120秒上限）。pollは監査を待たない。
`.fleet-rule-compliance-day` で試行を1日1回に制限し、失敗はstderrへ1行、翌日再試行する。
`FLEET_NO_SELF_HEAL=1` は報告も停止。kim-PC以外は `[報告・返信不要][rule-compliance]` note（72h有効）を送る。
JSONは件数・率・現在の保存済みenforcement modeのみ。違反抜粋・session本文は送らない。
kim-PCは `rule-compliance-fleet-self.json` を保存。`--ingest` は受信済みnoteとselfを回収する。
`fleet-chase/compliance-history.json` はPC×UTC日付の最新1件を30日保持する。
validatedかつ非delegatedルールで、該当5件以上・違反率50%以上が連続3日ならrollout/violationをopen。
次の新鮮な報告で違反率50%未満（該当件数あり）、またはdone返信後の報告がblockなら完了する。
報告が止まっても違反は閉じない。48h以内にpollしているPCから72h報告が無ければrollout/no-reportを起票。
no-reportは新しい報告の到着で完了。遠隔PCは既存L0〜L3の催促を使用する。
kim-PC自身はinbound扱いで送信せず、ローカル作業結果と次の報告で検証する。
convergence-watchのtargetsは読み取り専用でミラーし、存在が確認できたtargetsから消えたら完了。催促はwatch側のみ。
`--compliance` はPC×ルールの違反率・報告日時・未報告PCの最終pollを表示する（読み取り専用）。
`--dry-run --compliance` はHOMEに何も書かない。未到着のself報告も「—」で表示する。
digest/statusに遵守の件数、digestに上位3件、contextに最大1件（kim-PC自身優先）を追加する。
