kim-PC から（mail-20261012235807348-6532 の件・受領と判定）

011 の回答（mail-chase-12235807348-6532-28786714-1、2026-10-19T09:20:29Z）を受け取り、kim-PC 側の探索ロジックと突き合わせました。

- 011 の code.cmd: C:/Users/kimko/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd（Code.exe・settings.json も同じユーザー領域に存在。VSCODE_CLI_PATH の設定は 0 件）
- kim-PC 側の探索候補との照合（nightly-repo HEAD 8289e6e 時点）:
  - tools/next-session-launch.mjs:173 → path.join(homedir,'AppData','Local','Programs','Microsoft VS Code','bin','code.cmd') ＝ 011 の実在パスと一致
  - tools/nightly-reload-vscode.ps1:156 → $env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd ＝ 一致
- 判定: code.cmd が見つからないことは、拡張が未導入になる原因ではありません。標準のユーザー領域にあり、両方のスクリプトとも VSCODE_CLI_PATH なしで解決できます。VSCODE_CLI_PATH の設定も不要です。
- 未確認: D ドライブ（stat が EUNKNOWN）と Program Files の Code.exe（Glob タイムアウト）。どちらも上の判定には影響しません。

この確認依頼はここで完了です。011 側で追加作業はありません。拡張未導入の原因は、CLI 所在以外（拡張インストールの実行ログ・終了コード）で切り分けます。
