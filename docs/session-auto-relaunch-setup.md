# 別のPCでセッション自動再開を有効にする（Claude Code に貼るだけ）

この文書は **AI（Claude Code）への作業指示**である。人がやるのは、この文書を Claude Code に読ませることと、モードを1回選ぶことだけ。
AI は下の手順を最後まで自分で実行し、検証結果まで報告する。

渡し方（どちらでもよい）:

- 1行で渡す: 「https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/docs/session-auto-relaunch-setup.md を読んで、書いてある手順を実行して」
- すでにリポが入っているPCなら: 「`~/orgiast-claude-rules/docs/session-auto-relaunch-setup.md` を読んで実行して」

---

## 背景（AI はここを読んでから動く）

`/session-close` でセッションを閉じた後、次のセッションを自動で始める仕組みには **2つのモード**がある。

| mode | 何が起きるか | 人に残る操作 |
| --- | --- | --- |
| `window`（既定） | 新しい Windows Terminal ウィンドウで対話 CLI が起動し、初期プロンプトに `/session-start` が渡る | 初回だけ「このフォルダを信頼しますか」で Enter |
| `inline` | ウィンドウを開かず予約だけ置く。**次に開いたセッションが自分から `session-start` を実行する** | `/clear` の1打鍵だけ |

どちらも「操作ゼロ」にはならない。外部から `/clear` を発火させる公式手段が無く（`SessionEnd` フックは出力が無視される仕様）、
エディタ拡張のパネルも外部から新規会話を開けないため。**これは限界であり、隠して「完全自動」と報告しない。**

配布は自動である。セッション開始時に走る `onboarding-sync` が正本から `tools` / `skills` を丸ごと更新し、
その直後に `register-hooks.mjs --hooks-only` を必ず実行する。**新しいツールもフック登録も、人が何もしなくても降りてくる。**

---

## AI への指示

コマンドは Bash tool で実行する（`~` の展開が要る）。PowerShell で走らせるなら `~` を `$env:USERPROFILE` に読み替えること。

### 1. 最新を取り込む

```bash
node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force
```

### 2. inline が配られているか確認する

```bash
node -e "console.log(require('fs').existsSync(require('os').homedir()+'/orgiast-claude-rules/tools/session-relaunch.mjs'))"
```

- `false` の場合 → **inline はまだ正本にマージされていない**。このPCは既定の `window` で自動再開が既に動いている（壊れていない）。
  手順5の検証だけ行い、「window モードで稼働中／inline はマージ待ち」と報告して終わる。
  **未マージのブランチや fork を勝手に取りに行かないこと。**
- `true` の場合 → 手順3へ。

### 3. モードを人に選ばせる

上の表をそのまま示し、`window` と `inline` のどちらにするか聞く。**勝手に切り替えない。**
既定は `window` なので、選ばれなければ何も変更せず手順5の検証へ進む。

### 4. 選ばれたモードを設定する

```bash
node ~/orgiast-claude-rules/tools/next-session-launch.mjs --set-mode inline
```

`window` にするなら `--set-mode window`。このコマンドは `mode` だけを書き換え、`enabled` などの既存キーを保持する。
**`~/.claude/next-session-launch.json` を手で編集しない**（他のキーを巻き添えで消す事故が起きる）。

続けてフック登録を揃える。

```bash
node ~/orgiast-claude-rules/tools/register-hooks.mjs --hooks-only
```

### 5. 検証する（ここまでやって「動く」と言える）

**「画面で確認してください」と人に振らない。AI が自分でコマンドを走らせ、出力で判断する。**

```bash
cd ~/orgiast-claude-rules && node --test tools/next-session-launch.test.mjs tools/session-relaunch.test.mjs
```

- `session-relaunch.test.mjs` が無いPC（マージ前）は `tools/next-session-launch.test.mjs` だけを走らせる。
- 期待: `fail 0`。

```bash
node ~/orgiast-claude-rules/tools/next-session-launch.mjs --show-mode
node ~/orgiast-claude-rules/tools/next-session-launch.mjs --dry-run --session probe --cwd "$HOME"
```

- `--show-mode` が選んだモードを返すこと。
- `--dry-run` は **実際にはウィンドウを開かない**。`inline` なら `{"mode":"inline",...}`、`window` なら `wt.exe` か `cmd.exe` の起動計画 JSON が返る。

`inline` を選んだ場合のみ:

```bash
node ~/orgiast-claude-rules/tools/session-relaunch.mjs --status
```

- 期待: `有効 / <予約なし or 予約あり>`。まだ `/session-close` していなければ `予約なし` が正しい。直前に閉じていれば `予約あり: <日時> (<作業ディレクトリ>)` になるが、これも正常。`無効` と出たら `--on` で戻す。

最後にもう一度フック登録を流し、**重複していないこと**を確認する。

```bash
node ~/orgiast-claude-rules/tools/register-hooks.mjs --hooks-only
```

- 期待: `[OK] hook は既に登録済み(変更なし)`。`追加` と出るなら1回目が効いていないので原因を調べる。

### 6. 報告する

選んだモード / 検証結果（テストの pass 数、`--show-mode` の出力）/ 人に残る操作（`window` なら初回の信頼ダイアログ、`inline` なら `/clear`）を数行で報告する。

---

## うまくいかないときの切り分け

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| セッションを閉じても何も起きない | 予約が置かれるのは **`/session-close` を最後まで通した時だけ**。単に窓を閉じた・`/clear` だけした場合は自走しない | 仕様（安全装置）。自走させたいなら `/session-close` で閉じる |
| `inline` にしたのに新セッションが自分から始まらない | ①フック未登録 ②予約が無い ③開き方が対象外 | ① `register-hooks.mjs --hooks-only` ② `session-relaunch.mjs --status` ③ `--resume` での再開や文脈圧縮では発火しない仕様（同じ作業の続きなので） |
| 設定したのに動かない | `enabled:false` で停止中 | `node ~/orgiast-claude-rules/tools/next-session-launch.mjs --enable` |
| ウィンドウが増えて困る | `window` モードの仕様 | `--set-mode inline` に変える |
| 全部止めたい | — | `node ~/orgiast-claude-rules/tools/next-session-launch.mjs --disable` |
| 今回の予約だけ取り消したい | — | `node ~/orgiast-claude-rules/tools/session-relaunch.mjs --disarm` |

---

## AI がやってはいけないこと

- モードを**無断で切り替える**（必ず人に選ばせる）
- 「このフォルダを信頼しますか」ダイアログを**代理で承諾する**（セキュリティの同意ゲート。人が押す）
- 未マージのブランチや fork を勝手に取得する
- フック・承認プロンプト・permission mode を「通すために」無効化する
- 残る操作を隠して「完全自動になりました」と報告する
