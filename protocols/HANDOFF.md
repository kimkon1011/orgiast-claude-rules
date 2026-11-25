# HANDOFF

## TASK_ID
一意なタスクID。

## OBJECTIVE
達成する目的を1件だけ記載する。実行役はここから逸脱しない。

## BACKGROUND
判断に必要な背景だけを記載する。

## CONTEXT
読むファイル、既知の制約、該当memoryの要点を記載する。Codexはmemoryを継承しないため、必要事項を本文へ貼る。

## SOURCE_OF_TRUTH
正本の場所と版を固定する。実行役は勝手に変更しない。

## INPUT
入力、作成物、変更対象、必須内容を列挙する。

## CONSTRAINTS
禁止事項、互換性、行数、依存関係などを記載する。

## HUMAN_GATE
人の承認が必要な不可逆操作を列挙する。NONEなら明記する。実行役はHUMAN_GATEを越えない。

## DONE_CRITERIA
実行可能な検証コマンドと期待結果を記載する。実行役が自分で検証する。

## OUTPUT
成果物の場所と状態を記載する。

## REPORT_TO
返却先を記載する。

## 実行原則
- OBJECTIVEから逸脱しない。
- SOURCE_OF_TRUTHを勝手に変えない。
- 不可逆操作はHUMAN_GATEを越えない。
- 想定外、失敗、未検証を隠さない。
- DONE_CRITERIAを自分で実行し、結果を確認する。

## BLOCKED RULE
推測で進めない。ただし何でもuserに聞かない。手元のCONTEXT → 正本 → 既存Decision → 手順書 → memoryの順に自力解決を試みる。結果を大きく左右する未確定事項だけを司令塔へ戻す。

## CONTEXT ECONOMY
「知っていると便利」ではなく「今回の判断に必要」な情報だけを渡す。

## 渡し方
`node tools/codex-do.mjs --prompt-file <このテンプレで書いたmd> --cwd <対象>` を使う。シェルを通さずファイルで渡す（§1.17）。

## RETURN FORMAT
- TASK_ID
- STATUS（DONE|PARTIAL|BLOCKED|FAILED）
- RESULT
- ARTIFACTS
- VERIFICATION
- DECISIONS
- ISSUES
- LEARNING
- NEXT

## テストを含む委譲の必須記載
- テストの fixture・期待値は正本（本体コードの export／設定ファイル）から import して導出させる。正本の一覧を手写しさせない。「手写しのまま残せ」とも書かない（正本に1件足しただけで偽 fail になる）。
- 何かが「無い／売切／空」と主張する計測は、正常と分かっている対照群を同じ方法で測らせ、対照群も異常なら exit 2（測定不能）にさせる。
- assert を try/catch の中に入れさせない。

出典: AI廃人部 第3回オフ会（2026-09-16）司令塔型 AI-OS プロトコル（著者: ふみちゃん＝多動な廃人掃除屋）
