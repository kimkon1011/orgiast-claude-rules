# 別のPCでセッション自動再開を有効にする（Claude Code に貼るだけ）

この文書は **AI（Claude Code）への作業指示**である。人がやるのは、この文書を Claude Code に読ませることと、起動先を1回選ぶことだけ。AI は下の手順を最後まで自分で実行し、検証結果まで報告する。

渡し方（どちらでもよい）:

- 1行で渡す: 「https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/docs/session-auto-relaunch-setup.md を読んで、書いてある手順を実行して」
- すでにリポが入っているPCなら: 「`~/orgiast-claude-rules/docs/session-auto-relaunch-setup.md` を読んで実行して」

---

## 背景（AI はここを読んでから動く）

`/session-close` 後の起動先は3つある。

| target | 何が起きるか | 人に残る操作 |
| --- | --- | --- |
| `vscode`（既定） | VSCode に Claude Code の新しいタブを開き、入力欄へ `/session-start` を置く | Enter 1回 |
| `terminal` | 別ウィンドウで対話 CLI を起動し、初期プロンプトを渡す | 初回だけ信頼ダイアログ |
| `inline` | 何も開かず予約だけ置き、次のセッションが自分から `session-start` を実行する | `/clear` 1打鍵 |

どれも操作ゼロではない。外部から `/clear` を発火させる公式手段がなく、VSCode の URI も入力欄へ置くだけで送信しない。これは原理的限界なので、隠して「完全自動」と報告しない。

配布は `onboarding-sync` が正本から `tools` / `skills` を更新し、続けて `register-hooks.mjs --hooks-only` を実行する。

---

## AI への指示

コマンドは Bash tool で実行する。PowerShell なら `~` を `$env:USERPROFILE` に読み替える。

### 1. 最新を取り込む

```bash
node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force
```

### 2. inline が配られているか確認する

```bash
node -e "console.log(require('fs').existsSync(require('os').homedir()+'/orgiast-claude-rules/tools/session-relaunch.mjs'))"
```

- `false` なら正本へのマージ前。未マージの branch/fork を取らず、`vscode` 経路の検証だけ行って報告する。
- `true` なら手順3へ。

### 3. target を人に選ばせる

上の表をそのまま示し、`vscode` / `terminal` / `inline` のどれにするか聞く。勝手に切り替えない。選ばれなければ既定 `vscode` のまま検証へ進む。

### 4. 選ばれた target を設定する

```bash
node ~/orgiast-claude-rules/tools/next-session-launch.mjs --set-target inline
node ~/orgiast-claude-rules/tools/register-hooks.mjs --hooks-only
```

`inline` は選択値に置き換える。コマンドは `target` だけを書き換え、`enabled` や履歴を保持する。`~/.claude/next-session-launch.json` を手編集しない。停止中と出たら、人が再開を選んだ場合だけ `--enable` を実行する。

### 5. 検証する

人に画面確認を振らず、AI が実行して出力を判断する。

```bash
cd ~/orgiast-claude-rules
node --test tools/next-session-launch.test.mjs tools/session-relaunch.test.mjs
node tools/next-session-launch.mjs --show-target
node tools/next-session-launch.mjs --dry-run --session probe --cwd "$HOME"
node tools/register-hooks.mjs --hooks-only
node tools/register-hooks.mjs --hooks-only
```

- テストは `fail 0`。
- `--show-target` は `target=<解決結果> / enabled=<bool>`。
- dry-run は何も起動しない。`inline` は `{"route":"inline",...}`、`vscode` は VSCode の計画、`terminal` は CLI の起動計画を返す。
- 2回目の hook 登録は `[OK] hook は既に登録済み(変更なし)`。

`inline` の場合だけ状態も確認する。

```bash
node ~/orgiast-claude-rules/tools/session-relaunch.mjs --status
```

`有効 / 予約なし` または `有効 / 予約あり` が正常。`無効` なら、人が有効化を選んだ場合だけ `--on` を実行する。

### 6. 報告する

選んだ target、テスト pass 数と `fail 0`、`--show-target` の出力、人に残る操作（vscode は Enter、terminal は初回信頼、inline は `/clear`）を数行で報告する。

---

## うまくいかないときの切り分け

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| セッションを閉じても何も起きない | 予約/起動は `/session-close` 完走時だけ | 単に窓を閉じず `/session-close` を使う |
| vscode 経路でタブは開くのに始まらない | 入力欄に置くだけの仕様 | 入力欄を確認して Enter を押す |
| inline で自走しない | hook 未登録、予約なし、または resume/compact | hook 登録、`--status`、起動 source を確認 |
| 設定したのに動かない | `enabled:false` | `node ~/orgiast-claude-rules/tools/next-session-launch.mjs --enable` |
| タブや窓が増えて困る | vscode / terminal の仕様 | `--set-target inline` |
| 全部止めたい | — | `node ~/orgiast-claude-rules/tools/next-session-launch.mjs --disable` |
| 今回の予約だけ取り消したい | — | `node ~/orgiast-claude-rules/tools/session-relaunch.mjs --disarm` |

---

## AI がやってはいけないこと

- target を無断で切り替える
- 信頼ダイアログを、人の同意なしに代理承諾する
- 未マージの branch や fork を勝手に取得する
- hook・承認プロンプト・permission mode を通すために無効化する
- 残る操作を隠して「完全自動になりました」と報告する
