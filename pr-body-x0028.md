## X-0028: Claude Code+Codexで手順画像自動生成 — スクショ＋枠線＋番号を自動付与

### やったこと
- `docs/ai-news-x0028-codex-procedure-image.md` — 設計書。Claude Code＋Codexに指示するとスクショ＋枠線＋番号が自動で作られる仕組み。オージャストのブース設営・イベント準備・撤収の手順書解説画像を自動生成し、月間27.4時間の制作時間削減を見込む。
- `tools/procedure-image-generator.mjs` — CLIツール。手順定義JSONから以下を生成:
  - Codex委譲用プロンプト（Puppeteer/Playwrightでスクショ自動取得＋枠線＋番号バッジ付与）
  - プレビューHTML＋CSS（A4縦レイアウト、丸数字番号、赤枠アノテーション対応）
  - プレースホルダ画像（Codexが実スクショで上書き）
  - 3種のオージャスト標準テンプレート（ブース設営10手順、イベント準備8手順、撤収7手順）
- `tools/procedure-image-generator.test.mjs` — テスト39件、全件PASS

### 検証したこと
- `node --test tools/procedure-image-generator.test.mjs` (39/39 PASS)
- `node tools/procedure-image-generator.mjs --init` → テンプレートJSON出力確認
- `node tools/procedure-image-generator.mjs --codex-steps` → ブース設営Codexプロンプト出力確認
- `node tools/procedure-image-generator.mjs --validate <file>` → バリデーション動作確認
- 実ファイル出力: HTML/CSS/プレースホルダSVG の生成確認

### 残ったこと
- Codex連携検証（codex-do委譲で実際のスクショ取得＋枠線番号付与が動くか）は別セッション
- 実用手順書テンプレートの拡充（各案件に合わせたカスタマイズ）
- 生成画像のQAレビュー基準策定

### Note
fork PRのためautomerge対象外。kimkon1011 による squash-merge 1クリックが必要。

🤖 Generated with [Claude Code](https://claude.com/claude-code)