@REM 終了時に EXIT 非0 または STATUS が未完了なら追いかけ台帳へ登録する
@REM run-cc.ps1 の最後（exit チェックの前後）に差し込んで使う
node tools/ledger-open-item.mjs open --id "GB-OPEN-%%~nxf" --task "%%TODO: 実際のタスク説明%%" --owner-pc "%%PC%%" --status "止まった" --reason "exit=%%EXITCODE%%" --tema-check "[TEMA-CHECK] 自動登録 [/TEMA-CHECK]"