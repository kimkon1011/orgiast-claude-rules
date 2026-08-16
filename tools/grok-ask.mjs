// grok-ask.mjs — xAI Grok(定額枠/API)へ問い合わせるCLIヘルパー。対話・最新情報向け(開発ROIは低め)。
// 使い方: node grok-ask.mjs "質問"  [--model grok-3] [--system "..."] [--max 4000]
// 認証: XAI_API_KEY (env もしくは ~/.claude/xai.env)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const BASE = 'https://api.x.ai/v1/chat/completions';

function loadKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'xai.env'), 'utf-8').split(/\r?\n/)) {
      if (l.startsWith('XAI_API_KEY=')) return l.slice('XAI_API_KEY='.length).trim();
    }
  } catch {}
  return '';
}

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; }
const model = opt('--model', 'grok-3');
const system = opt('--system', '');
const maxTok = parseInt(opt('--max', '4000'), 10) || 4000;
const flagIdx = new Set();
['--model', '--system', '--max'].forEach((f) => { const i = args.indexOf(f); if (i >= 0) { flagIdx.add(i); flagIdx.add(i + 1); } });
const prompt = args.filter((a, i) => !a.startsWith('--') && !flagIdx.has(i)).join(' ').trim();

const KEY = loadKey();
if (!KEY) { console.error('XAI_API_KEY 未設定 (~/.claude/xai.env)'); process.exit(2); }
if (!prompt) { console.error('使い方: node grok-ask.mjs "質問"'); process.exit(2); }

const messages = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });

(async () => {
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTok, stream: false }),
    });
    if (!r.ok) { console.error(`Grok失敗 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`); process.exitCode = 1; return; }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content ?? '';
    const u = j.usage ?? {};
    console.log(text.trim() || '(出力なし)');
    console.error(`[grok ${model}] in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0}`);
    try { fs.appendFileSync(path.join(os.homedir(), '.claude', 'executor-usage.jsonl'), JSON.stringify({ t: new Date().toISOString(), provider: 'grok', model, in: u.prompt_tokens || 0, out: u.completion_tokens || 0 }) + '\n'); } catch {}
  } catch (e) { console.error('Grok例外:', e.message); process.exitCode = 1; }
})();
