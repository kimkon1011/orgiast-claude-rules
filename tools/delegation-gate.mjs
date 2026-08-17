#!/usr/bin/env node

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  if (!raw) process.exit(0);
  const j = JSON.parse(raw);
  const prompt = String(j.prompt || '');
  if (prompt.length < 4) process.exit(0);
  if (/codex/i.test(prompt) || prompt.includes('[委譲判定]')) process.exit(0);

  const implementationPattern = /実装|作って|作成して|書いて|追加して|直して|修正|治して|リファクタ|refactor|バグ|bug|fix|implement|コード|関数|スクリプト|hook作|ツール作|アプリ作|新規作成|作り直|置き換え|移行|デバッグ|debug|エラーを|動かない|動くように/i;
  if (!implementationPattern.test(prompt)) process.exit(0);

  const questionPattern = /どう思う|教えて|説明して|とは|なぜ|理由|どっち|比較|調べて|確認して|見て/i;
  const strongImplementationPattern = /実装|作って|書いて|直して|修正|fix|implement/i;
  if (questionPattern.test(prompt) && !strongImplementationPattern.test(prompt)) process.exit(0);

  const ctx = `[委譲ゲート §1.18] このプロンプトは実装依頼と判定。コードを書き始める前に、応答の最初に必ず1行で宣言せよ:
  \`**[委譲判定]** 実装=Codex（理由: …）\` または \`**[委譲判定]** 自分で実施（理由: 数行の修正 / 設定ファイル / 設計試行錯誤中 / Codex呼出オーバーヘッドの方が重い）\`
宣言せずに Write/Edit で実装を書き始めるのは §1.18 違反。宣言は user に見える形で出す。
■ルーティング: 実装本体→**Codex(定額枠・従量$0)** \`wsl -d Ubuntu --cd "<Winパス>" -- codex exec "指示"\` / 量産・分類・抽出→**Groq** \`node tools/llm-ask.mjs --provider groq "指示"\` / 汎用の安い推論→**OpenRouter** / 長文脈・全体読み・Web検索→**Gemini** / 探索は Agent(Explore)に「結果200字・コード本体なし」で委譲。
■監督(あなた)の担当は 設計・タスク分解・指示・レビュー・**verify(実行して動作確認)** のみ。大きな実装を手打ちしない=これが最大のコストレバー。
■Codex に投げる時は MEMORY.md + 当該タスクに関連する memory ファイル + project CLAUDE.md をキュレートして**プロンプトに同梱**する(Codex は Claude の蓄積を継承しないため、素で投げると気が利かない)。`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
} catch {}
process.exit(0);
