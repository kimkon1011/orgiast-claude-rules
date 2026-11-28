🔴 followup-ledger: 人に頼んだら必ず1行。自分が受けた依頼も1行。
🔴 完了は実物（URL・返信・追跡番号・ファイル）。exit 0・approvedだけは不可。
🔴 `node tools/followup-ledger.mjs add --id <ID> --to <相手> --channel <経路> --chat <ID> --task "<依頼>" --done-when "<完了条件>" --owner-ai "Claude Code" --kind human --requested-by <依頼元> --tema-check <記録ファイル>`
🔴 AI宛ては `--kind ai`。担当PCは空でよい（催促役008）。
🔴 登録失敗は `node tools/followup-ledger.mjs doctor` → 復旧後 `node tools/followup-ledger.mjs sync`。
🔴 正本: https://docs.google.com/spreadsheets/d/1-aTeXKH0EYATi-SnSAIeRH3gGTki9YUMiTntTAQa-2U/edit
