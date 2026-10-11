制作アプリへ clasp push した自動セッションが GitHub を更新せず、別PCが本番/master の drift を検出する問題を修正します。既存の gas-overlay-push.mjs の本番 read-back 後、同じ実行内で GitHub へ同期します。

- 対象 scriptId を制作アプリに限定。全 GAS ファイルの read-back 一致を確認し、専用の一時 clone へ本番 src を反映。src だけを commit し、git push origin HEAD → git push origin HEAD:master を実行します。共有ツリー・index は変更せず、本番専用ファイルとローカルテストを保持します。
- master が fast-forward 不可なら force push せず base master の PR を作り、URL と「master が先行。PR で統合」を出力。GitHub 同期失敗は JSON の gitSync.status=failed に分離し、成功済みの clasp push の終了結果を変更しません。dry-run は Git を実行しません。
- nightly-health に週1回の監査を追加。本番を一時ディレクトリへ pull し、最新 master と git diff --no-index --stat -w --exit-code で比較。差分時だけ既存 notify-kim 経路で1行通知します。pull・通知失敗時は週次チェック済みにせず再試行します。
- rules/gas.md と skills/autopilot/SKILL.md に同じターンで同期するルールを追加しました。

調査: autopilot-*.mjs / auto-session*.mjs / protocols / autopilot skill に直接の clasp push 実行はありません。rules/gas.md が誘導する tools/gas-overlay-push.mjs に実行箇所が存在しました。制作アプリのローカル CLAUDE.md に手動手順があり、tools/ と scripts/ は存在しませんでした。元の dirty ツリーと proposal-session は編集していません。

検証: node --test tools/gas-master-drift.test.mjs tools/gas-master-sync.test.mjs tools/gas-overlay-push.test.mjs tools/nightly-health.test.mjs → pass 82 / fail 0。spawn モックで成功時の push 2本、clasp 失敗時の Git 未実行、ff 不可時の PR、dry-run、同期失敗の分離を確認。監査テストでは実際の git diff で空白・拡張子差を検証。git diff --check 成功。本番デプロイ・実DM送信は実施していません。

制作アプリ側の CLAUDE.md も別PRで更新します。マージはしていません。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
