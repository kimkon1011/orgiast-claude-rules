# Mac版 オージャスト Claude セットアップ

Windowsの手順(PowerShell)とは別物なので混ぜないでください。

## 手順

1. Launchpad または Spotlight で「ターミナル」を検索して開きます。
2. 配布者から受け取った下のコマンドを、最初から最後まで全部コピーしてターミナルへ貼り付け、Enter キーを押します。
3. あとは自動で進みます。途中で注意が表示されても、ほかの設定は続行されます。
4. 最後に Codex のログイン画面が開いたら、会社共有アカウント `seisaku-team@orgiast.jp` を選びます。
5. 完了メッセージが出たら Claude Code を開き直します。Mac の再起動は不要です。

## 貼り付けるコマンド

配布者は `<配布者が埋める>` の部分を実際の値に置き換えてから渡してください。APIキーをこの文書へ直接保存しないでください。

```bash
export ORGIAST_WEBHOOK='<配布者が埋める>'; export ORGIAST_LABEL='<配布者が埋める・空でも可>'; export ORGIAST_MANUS_KEY='<配布者が埋める>'; export ORGIAST_DEEPSEEK_KEY='<配布者が埋める>'; export ORGIAST_GROK_KEY='<配布者が埋める>'; export ORGIAST_OPENROUTER_KEY='<配布者が埋める>'; export ORGIAST_GROQ_KEY='<配布者が埋める>'; export ORGIAST_MISTRAL_KEY='<配布者が埋める>'; export ORGIAST_KIMI_KEY='<配布者が埋める>'; export ORGIAST_GEMINI_KEY='<配布者が埋める>'; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.sh)"
```

## 終了後

ターミナル末尾の `[NG]` や `[注意]` が残った場合は、その画面をそのまま kim に送ってください。セットアップは何度実行しても二重登録されず、既存の env ファイルも上書きしません。

## うまくいかない時

`zsh: command not found: node` などが出たら、ターミナルを一度閉じて開き直し、もう一度貼り付けてください。
会社ネットワークやプロキシの影響でダウンロードに失敗することがあります。その場合は画面をそのまま kim に送ってください。
Codex のログイン画面が開かない時は、ターミナルに `codex login` と入力してください。
Ollama（無料ローカルAI）は Mac 版では未対応ですが、ほかの機能はすべて動きます。
