#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"app-llm-cost-gate","remedies":[{"kind":"command","ref":"Add // LLM-PROVIDER-REASON: <reason>, or measure 1 to 10 items and provide a matching COST-ESTIMATE within budget. Emergency bypass: APP_LLM_COST_GATE=off."}]};
import fs from 'node:fs';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { readAssistantText } from './lib/assistant-text.mjs';

const markers = ['@anthropic-ai/sdk', 'new Anthropic(', 'api.anthropic.com', 'anthropic.messages.create', 'client.messages.create', 'web_search_20'];
const providerMessage = 'アプリの LLM/検索は他AIが既定（ONBOARDING §2.8.0）。Web検索付き収集=Gemini Flash グラウンディング、分類・抽出・要約=Groq/DeepSeek/Gemini Flash。Claude API を使うなら `// LLM-PROVIDER-REASON: <比較した他AI 3社以上の名前と実測値>` を書く（1社だけ試して Claude に戻すのは禁止）。Claude への自動フォールバックは禁止。落とす先は別の他AI、全滅なら止めて通知（§2.8.0 5）';
const bulkMessage = '一括実行の前に、1〜10件で1件あたり実費を実測し、[COST-ESTIMATE: 1件 $X(n件実測)×N件=$Y / 上限$Z] を書く。自動リロードは予算上限ではない。予算上限はコード側で env (例 BULK_BUDGET_USD) により自動停止させる（§2.8.0）';

function estimateMatches(text, count) {
  const amount = '(\\d+(?:\\.\\d+)?)';
  const pattern = new RegExp('^\\s*\\[COST-ESTIMATE:\\s*1件(?:あたり実測)?\\s*\\$' + amount + '\\s*[（(]\\s*(\\d+)件(?:で測定|実測)\\s*[）)]\\s*[×x*]\\s*(\\d+)件\\s*=\\s*\\$' + amount + '\\s*/\\s*(?:予算上限|上限)\\s*\\$' + amount + '\\s*\\]', 'm');
  const m = text.match(pattern);
  if (!m) return false;
  const [unit, sample, n, total, budget] = m.slice(1).map(Number);
  return sample >= 1 && sample <= 10 && n === count && total <= budget && Math.abs(unit * n - total) <= 0.005;
}

export function evaluate(input) {
  if (process.env.APP_LLM_COST_GATE === 'off') return;
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
    if (typeof args.file_path !== 'string') return;
    const file = path.resolve(cwd, args.file_path);
    const normalized = file.replaceAll('\\', '/');
    if (/(?:^|\/)(?:orgiast-claude-rules|\.claude)(?:\/|$)|\.test\.[^/]+$|\.md$/i.test(normalized)) return;
    const edits = tool === 'MultiEdit' ? args.edits : [tool === 'Write' ? { new_string: args.content } : args];
    if (!Array.isArray(edits)) return;
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 理由行には比較した他AIを3社以上書く（1社だけ試して Claude に戻すのは禁止・§2.8.0 1-2）
    const reasonLines = (text) => [...String(text || '').matchAll(/(?:\/\/|\/\*|#|<!--)\s*LLM-PROVIDER-REASON:\s*([^\r\n]+)/g)].map(m => m[1]);
    const otherAis = /gemini|perplexity|sonar|grok|xai|kimi|moonshot|deepseek|groq|mistral|glm|openrouter|qwen|cerebras/gi;
    const enough = (line) => new Set((line.match(otherAis) || []).map(s => s.toLowerCase().replace(/^sonar$/, 'perplexity').replace(/^xai$/, 'grok').replace(/^moonshot$/, 'kimi'))).size >= 3;
    if ([existing, ...edits.map(e => e.new_string)].some(t => reasonLines(t).some(enough))) return;
    const claudeModel = /["'`]claude-(?:haiku|sonnet|opus|fable)[\w.-]*["'`]/gi;
    const anthropicDefault = /(?:\?\?|\|\||\?|:|\breturn\b|\bdefault\b|=)\s*["'`]anthropic["'`]|["'`]anthropic["'`]\s*(?:\?\?|\|\||\?|:|\breturn\b|\bdefault\b|=)/i;
    const newlyAddsClaudeModel = (edit) => {
      const added = String(edit.new_string || '').match(claudeModel) || [];
      const old = new Set((String(edit.old_string || '').match(claudeModel) || []).map(value => value.toLowerCase()));
      return added.some(value => !old.has(value.toLowerCase()));
    };
    const newlyAddsAnthropicDefault = (edit) => anthropicDefault.test(String(edit.new_string || ''))
      && !anthropicDefault.test(String(edit.old_string || ''));
    if (edits.some(e => markers.some(word => String(e.new_string || '').includes(word) && !String(e.old_string || '').includes(word))
      || newlyAddsClaudeModel(e) || newlyAddsAnthropicDefault(e))) return providerMessage;
  }
  if (tool !== 'Bash' || typeof args.command !== 'string') return;
  // Inspect each shell segment without executing the command.
  let blockedSegment = false;
  for (const segment of args.command.split(/&&|\|\||[;\n|]/)) {
    const tokens = segment.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(s => s.replace(/^(['"])(.*)\1$/, '$2')) || [];
    let file, counts = [], source;
    const gh = tokens.findIndex((t, i) => t === 'gh' && tokens[i + 1] === 'workflow' && tokens[i + 2] === 'run');
    if (gh >= 0) {
      file = path.resolve(cwd, '.github/workflows', tokens[gh + 3] || '');
      for (let i = gh + 4; i < tokens.length; i++) {
        const field = /^(?:-f|-F|--field|--raw-field)$/.test(tokens[i]) ? tokens[++i] : tokens[i].replace(/^(?:-[fF]|--(?:raw-)?field=)/, '');
        const unquoted = field?.replace(/^(['"])(.*)\1$/, '$2');
        const m = unquoted?.match(/^(?:limit|count|total|items|rows|batch)=(\d+)$/i);
        if (m) counts.push(Number(m[1]));
      }
      try { source = fs.readFileSync(file, 'utf8'); } catch { source = null; }
      if (source === null) { blockedSegment = true; continue; }
      if (!counts.length) {
        counts = [...source.matchAll(/\b(?:limit|count|total|items|rows|batch)\s*:\s*(?:\r?\n\s+[^\r\n]+)*?\r?\n\s+default\s*:\s*["']?(\d+)/gi)].map(match => Number(match[1]));
      }
    } else {
      const start = tokens.findIndex((t, i) => t === 'node' || t === 'npx' && (tokens[i + 1] === 'tsx' || tokens[i + 1] === '--yes' && tokens[i + 2] === 'tsx') || t === 'pnpm' && tokens[i + 1] === 'exec' && tokens[i + 2] === 'tsx' || t === 'npm' && tokens[i + 1] === 'run');
      if (start < 0) continue;
      let index;
      if (tokens[start] === 'node') index = start + 1;
      else if (tokens[start] === 'npx') index = start + (tokens[start + 1] === '--yes' ? 3 : 2);
      else if (tokens[start] === 'pnpm') index = start + 3;
      else {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.resolve(cwd, 'package.json'), 'utf8'));
          const script = pkg.scripts?.[tokens[start + 2]] || '';
          const scriptFile = script.match(/(?:^|\s)(?:node|(?:npx\s+(?:--yes\s+)?|pnpm\s+exec\s+)?tsx)\s+(\S+)/)?.[1];
          if (!scriptFile) continue;
          file = path.resolve(cwd, scriptFile);
        } catch { continue; }
        index = start + 3;
      }
      if (!file) {
        if (!/^(?:\.\/)?scripts\//.test(tokens[index] || '')) continue;
        file = path.resolve(cwd, tokens[index]);
        index++;
      }
      const numeric = tokens.slice(index).find(t => /^\d+$/.test(t));
      if (numeric) counts = [Number(numeric)];
      try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    }
    const large = counts.filter(n => n > 20);
    if (!large.length) continue;
    if (!/\b(?:ANTHROPIC|OPENAI|GEMINI|XAI|OPENROUTER|GROQ|DEEPSEEK|MOONSHOT|KIMI|MISTRAL|GLM|ZAI|CEREBRAS|PERPLEXITY)_API_KEY\b/.test(source)) continue;
    const latest = readAssistantText(input.transcript_path);
    if (latest.reason === 'unreadable') return;
    if (!large.every(n => estimateMatches(latest.text, n))) blockedSegment = true;
  }
  if (blockedSegment) return bulkMessage;
}

try {
  const raw = await readStdinWithTimeout();
  if (raw) {
    const reason = evaluate(JSON.parse(raw));
    if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
} catch { /* Fail open on malformed input or unavailable files. */ }
