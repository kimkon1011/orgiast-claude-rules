// deepseek-ask.mjs — 安い推論/生成を DeepSeek(激安API・Claudeの約1/10〜1/20)へ委譲するCLIヘルパー。
// 目的: 分類・抽出・下書き・安い推論などを DeepSeek に流し、Claude従量トークンを節約(§1.13/§1.17.1)。
// 使い方: node deepseek-ask.mjs "指示/質問"
//   モデル: 既定 deepseek-chat(V3・汎用)。--reasoner で deepseek-reasoner(R1・難しい推論)。
//   --system "..." でシステムプロンプト。--max <tokens>(既定4000)。
// 認証: DEEPSEEK_API_KEY (env もしくは ~/.claude/deepseek.env)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const BASE = 'https://api.deepseek.com/chat/completions';

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'deepseek.env'), 'utf-8').split(/\r?\n/)) {
      if (l.startsWith('DEEPSEEK_API_KEY=')) return l.slice('DEEPSEEK_API_KEY='.length).trim();
    }
  } catch {}
  return '';
}

const args = process.argv.slice(2);
const useReasoner = args.includes('--reasoner');
let system = ''; const si = args.indexOf('--system'); if (si >= 0 && args[si + 1]) system = args[si + 1];
let maxTok = 4000; const mi = args.indexOf('--max'); if (mi >= 0 && args[mi + 1]) maxTok = parseInt(args[mi + 1], 10) || 4000;
const skip = new Set();
if (si >= 0) { skip.add(si); skip.add(si + 1); }
if (mi >= 0) { skip.add(mi); skip.add(mi + 1); }
const prompt = args.filter((a, i) => !a.startsWith('--') && !skip.has(i)).join(' ').trim();

const KEY = loadKey();
if (!KEY) { console.error('DEEPSEEK_API_KEY 未設定 (~/.claude/deepseek.env)'); process.exit(2); }
if (!prompt) { console.error('使い方: node deepseek-ask.mjs "指示"'); process.exit(2); }

const messages = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });

(async () => {
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useReasoner ? 'deepseek-reasoner' : 'deepseek-chat', messages, max_tokens: maxTok, stream: false }),
    });
    if (!r.ok) { console.error(`DeepSeek失敗 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`); process.exitCode = 1; return; }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content ?? '';
    const u = j.usage ?? {};
    console.log(text.trim() || '(出力なし)');
    // 実コスト概算(DeepSeek目安: chat in $0.27/out $1.10, reasoner in $0.55/out $2.19 per 1M・時期で変動)
    const [pin, pout] = useReasoner ? [0.55, 2.19] : [0.27, 1.10];
    const cost = ((u.prompt_tokens || 0) * pin + (u.completion_tokens || 0) * pout) / 1e6;
    console.error(`[deepseek ${useReasoner ? 'reasoner' : 'chat'}] in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0} 概算$${cost.toFixed(5)}`);
    try { fs.appendFileSync(path.join(os.homedir(), '.claude', 'executor-usage.jsonl'), JSON.stringify({ t: new Date().toISOString(), provider: 'deepseek', model: useReasoner ? 'deepseek-reasoner' : 'deepseek-chat', in: u.prompt_tokens || 0, out: u.completion_tokens || 0 }) + '\n'); } catch {}
  } catch (e) { console.error('DeepSeek例外:', e.message); process.exitCode = 1; }
})();
