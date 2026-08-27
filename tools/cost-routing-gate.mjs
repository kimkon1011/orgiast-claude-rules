#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  if (!raw) process.exit(0);
  const input = JSON.parse(raw);
  const prompt = String(input.prompt || '');
  if (prompt.length < 2) process.exit(0);
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const codex = `node "${path.join(repo, 'tools', 'codex-do.mjs')}" "指示"`;
  const ask = `node "${path.join(repo, 'tools', 'llm-ask.mjs')}"`;
  const enqueue = `node "${path.join(repo, 'tools', 'batch-enqueue.mjs')}"`;
  const parts = [];
  const fableExplicit = /fable\s*-?\s*5|fable5|claude-fable-5|fable\s*(?:で|を使)/i;
  const fableNegative = /(?:fable\s*-?\s*5|fable5|claude-fable-5|fable)\s*(?:は|を)?\s*(?:使うな|使わない|使わず|使わなく|使わん|使用しない|利用しない|禁止|使用中止|不可)/i;
  if (fableExplicit.test(prompt) && !fableNegative.test(prompt)) {
    const home = process.env.ORGIAST_HOME || os.homedir();
    const allow = {
      until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      prompt: prompt.slice(0, 120),
    };
    try {
      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'fable-allow.json'), `${JSON.stringify(allow, null, 2)}\n`);
    } catch {}
    parts.push('§1.16の例外: userが明示指定したため今回に限りFable5使用可(60分/このセッション限り・別課金枠なので当該タスクのみ)');
  }
  const implementationPattern = /実装|作って|作成して|書いて|追加して|直して|修正|治して|リファクタ|refactor|バグ|bug|fix|implement|コード|関数|スクリプト|hook作|ツール作|アプリ作|新規作成|作り直|置き換え|移行|デバッグ|debug|エラーを|動かない|動くように/i;
  const questionPattern = /どう思う|教えて|説明して|とは|なぜ|理由|どっち|比較|調べて|確認して|見て/i;
  const strongImplementation = /実装|作って|書いて|直して|修正|fix|implement/i;
  let suggestCodexDelegation = null;
  if (!prompt.includes('[委譲判定]') && implementationPattern.test(prompt) && (!questionPattern.test(prompt) || strongImplementation.test(prompt))) {
    const codexCmd = `node "${path.join(repo, 'tools', 'codex-do.mjs')}" "prompt: user指示\ncontext: 自動委譲"`;
    suggestCodexDelegation = {
      action: 'suggest_codex_delegation',
      command: codexCmd,
      reason: '実装タスク=Codex に委譲（定額枠）'
    };
    parts.push(`[実装ルーティング §1.18] 応答冒頭に必ず1行で \`**[委譲判定]** 実装=Codex（理由: …）\` または \`**[委譲判定]** 自分で実施（理由: 数行/設定/設計試行錯誤中）\` と宣言。推奨: \`${codex}\``);
  }
  if (/分類|抽出|仕分け|タグ付け|整形|正規化|一括|まとめて|全部の|それぞれの|各社|各件/.test(prompt)) {
    parts.push(`[量産ルーティング] 分類・抽出・整形は \`${ask} --provider groq "指示"\` (0.6秒級/激安)、汎用の安い逃がしは \`--provider openrouter\`。`);
  }
  if (/生成|作文|文章|返信|メール|要約|下書き|提案文|説明文/.test(prompt)) {
    parts.push(`[生成ルーティング] 中量級の生成・推論・下書きは \`${ask} --provider kimi "指示"\` (Kimi K3・別課金プール、reasoning_effort=noneで2〜3秒)。長文脈の要約/整形は \`--provider gemini\`。Claude(監督)が自分で書くのは最後の手段。`);
  }
  if (/全体を読|コードベース全部|横断で調べ|ログ全部|PDF|検索して|調べて/.test(prompt)) {
    parts.push('[長文脈ルーティング] MCP `gemini-cli` の `googleSearch`/`geminiChat`(無料枠1M)へ委譲。探索は Agent(Explore)に「結果200字・コード本体なし」で。');
  }
  const countMatch = prompt.match(/(\d{2,})\s*(件|社|行|本|通|人|個|ファイル)/);
  if (!prompt.includes('[夜間判定]') && ((countMatch && Number(countMatch[1]) >= 20) || /一括生成|全件|バックフィル|エンリッチ|洗い出して全部|棚卸し|全部に対して|再生成/.test(prompt))) {
    if (/今すぐ|すぐに|至急|急ぎ|今日中|即時|リアルタイム|いま必要|今必要/.test(prompt)) {
      parts.push(`[夜間バッチ §2.8.1] 応答冒頭に必ず1行で \`**[夜間判定]** 即時実行（理由: user が急ぎと明示）\` と宣言し、同期実行(\`${ask}\`)へ回す。`);
    } else {
      parts.push(`[夜間バッチ §2.8.1] 応答冒頭に必ず1行で \`**[夜間判定]** 夜間バッチ(半額・翌朝03:00) — 投入: ${enqueue} --provider <deepseek|gemini|openrouter|groq> "指示"\` または \`**[夜間判定]** 即時実行（理由: user が待っている / ブロッキング / 20件未満相当）\` と宣言。宣言せずに着手するのは §2.8.1 違反。夜間に落とすなら黙って遅延させず、user に「夜間(半額・翌朝結果)でよいか、今すぐ必要か」を伝え、今すぐと言われたら同期実行(\`${ask}\`)に切替える。`);
    }
  }
  // "codex" という語だけでは処理全体をバイパスしない。分類なしの場合も監督責務を注入する。
  parts.push('[監督の担当] 設計・分解・指示・レビュー・verify。実働は用途別の安い/定額経路へ流す(§1.18)。');
  const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n') } };
  if (suggestCodexDelegation) {
    output.hookSpecificOutput.suggestCodexDelegation = suggestCodexDelegation;
  }
  console.log(JSON.stringify(output));
} catch {}
process.exit(0);
