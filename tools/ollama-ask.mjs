// ollama-ask.mjs — ローカルOllama(完全無料・API課金ゼロ)へ問い合わせるCLIヘルパー。
// 用途: 分類・抽出・軽い生成/整形など"大量の軽作業"をオフラインでこなし、Claude従量トークンを節約(§1.13/§1.17.1)。
// 使い方: node ollama-ask.mjs "指示"  [--model qwen2.5:3b] [--system "..."]
// 前提: Ollamaが導入済み(ollama serve 稼働・localhost:11434)。既定モデル qwen2.5:3b。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; }
// 既定モデル: env OLLAMA_MODEL → --model → ~/.claude/ollama.env → qwen2.5:3b
function fileModel() { try { for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'ollama.env'), 'utf-8').split(/\r?\n/)) { if (l.startsWith('OLLAMA_MODEL=')) return l.slice('OLLAMA_MODEL='.length).trim(); } } catch {} return ''; }
const model = opt('--model', process.env.OLLAMA_MODEL || fileModel() || 'qwen2.5:3b');
const system = opt('--system', '');
const flagIdx = new Set();
['--model', '--system'].forEach((f) => { const i = args.indexOf(f); if (i >= 0) { flagIdx.add(i); flagIdx.add(i + 1); } });
const prompt = args.filter((a, i) => !a.startsWith('--') && !flagIdx.has(i)).join(' ').trim();
if (!prompt) { console.error('使い方: node ollama-ask.mjs "指示"'); process.exit(2); }

const messages = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });

(async () => {
  try {
    const r = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // num_gpu:0 = CPU実行に固定(GPU/CUDAの相性問題で落ちるPCがあるため。軽作業なのでCPUで十分・全PCで確実に動く)
      body: JSON.stringify({ model, messages, stream: false, options: { num_gpu: 0 } }),
    });
    if (!r.ok) { console.error(`Ollama失敗 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)} (Ollama未起動 or モデル未取得の可能性: ollama pull ${model})`); process.exitCode = 1; return; }
    const j = await r.json();
    const text = j.message?.content ?? '';
    console.log((text || '(出力なし)').trim());
    console.error(`[ollama ${model}] 無料(ローカル) eval=${j.eval_count || 0}tok`);
  } catch (e) { console.error(`Ollama接続失敗: ${e.message} (Ollamaが起動しているか確認)`); process.exitCode = 1; }
})();
