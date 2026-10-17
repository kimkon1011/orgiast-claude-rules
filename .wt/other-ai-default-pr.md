他AIの残高切れ・403に対して「外す」を選択肢に出していたため、他AIの積極利用を既定とする指定文を配布ルールに追加しました。

- `CLAUDE.md.template`: 「トークン効率」節の直後に追加。
- `ONBOARDING.md`: §1.18 配下の末尾、§1.19 の直前に追加。指定文との完全一致を優先し、見出しも指定どおり保持。
- `rules/`・`protocols/` の障害時運用で Kimi／Mistral を「外す」ことを既定とする記述: 該当なし。

検証: `node --test` は終了コード 0（tests 4137 / pass 4124 / fail 0 / skipped 13）。`git diff --check` 成功。両ファイルの追加節は指定文と一字一句同じであることを文字列比較と diff で確認しました。新規テストは追加していません。

既存ツリーの Git 管理領域が作業フォルダ外で読み取り専用だったため、`.wt/other-ai-default-source` に独立 clone を作成し、その `origin/main` から指定の `.wt/other-ai-default` に worktree を作成しました。既存の dirty なファイルは変更していません。マージは行いません。

両ファイル共通の追加節:

```diff
+## 他AIは「積極的に使う」のが既定（kim 2026-10-09 厳命・全PC全アカウント）
+
+Codex／Gemini／DeepSeek／Groq／Kimi／Mistral／OpenRouter／GLM などの他AIは**使うのが既定**。Claude だけで済ませる方が例外で、例外には理由の明記が要る。
+- 残高切れ → 「入金する（オートチャージ ON）」が既定。キー失効・403 → 「再発行する」が既定。429 → 別の他AIへ自動切替。**「外す／やめる／縮小」を kim への選択肢に並べない。**
+- 他AIの障害は Claude で代替せず、別の他AIで吸収し、復旧したら戻す。Claude（監督）へ逆流させるのが最も高くつく。
+- 作業の割り振りは他AIレーン名を**先に・具体的に**書く（例: 要約=Gemini、下書き=Kimi、実装=Codex、Claude=verify のみ）。「必要なら他AIも使う」のような弱い表現は禁止。
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
