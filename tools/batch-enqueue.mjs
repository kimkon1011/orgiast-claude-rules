// batch-enqueue.mjs — 夜間バッチ用ジョブを ~/.claude/batch-queue/pending.jsonl へ追加する。
// 使い方: node batch-enqueue.mjs --provider <deepseek|gemini|openrouter|groq|kimi|anthropic> "指示" [--model X] [--system S] [--max N]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PROVIDERS = {
  deepseek: { model: 'deepseek-chat' },
  gemini: { model: 'gemini-3.7-flash' },
  openrouter: { model: 'meta-llama/llama-3.3-70b-instruct' },
  groq: { model: 'llama-3.3-70b-versatile' },
  kimi: { model: 'kimi-k3' },
  anthropic: { model: 'claude-haiku-4-5-20251001' },
};

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; }
const provider = (opt('--provider', '') || '').toLowerCase();
const P = PROVIDERS[provider];
if (!P) { console.error('使い方: node batch-enqueue.mjs --provider <deepseek|gemini|openrouter|groq|kimi|anthropic> "指示" [--model X] [--system S] [--max N]'); process.exit(2); }
const model = opt('--model', P.model);
const system = opt('--system', '');
const max = parseInt(opt('--max', '4000'), 10) || 4000;
const skip = new Set();
['--provider', '--model', '--system', '--max'].forEach((f) => { const i = args.indexOf(f); if (i >= 0) { skip.add(i); skip.add(i + 1); } });
const prompt = args.filter((a, i) => !a.startsWith('--') && !skip.has(i)).join(' ').trim();
if (!prompt) { console.error('指示テキストがありません'); process.exit(2); }

const nativeHome = os.homedir(); const home = process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || nativeHome;
const dir = path.join(home, '.claude', 'batch-queue');
const pending = path.join(dir, 'pending.jsonl');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
let seq = 1;
try {
  for (const line of fs.readFileSync(pending, 'utf-8').split(/\r?\n/)) {
    try { const id = JSON.parse(line).id || ''; if (id.startsWith(stamp + '-')) seq = Math.max(seq, (parseInt(id.slice(stamp.length + 1), 10) || 0) + 1); } catch {}
  }
} catch {}
const job = { id: `${stamp}-${String(seq).padStart(3, '0')}`, provider, model, system, prompt, max, enqueuedAt: new Date().toISOString() };
fs.appendFileSync(pending, JSON.stringify(job) + '\n');
console.log(`${job.id} を夜間バッチに追加 (${provider}:${model})`);
console.log(job.provider === 'kimi'
  ? `→ Kimiは割引待ちせず次回実行時に処理されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。`
  : job.provider === 'anthropic' ? `→ Anthropic Message Batchesで常時50%off処理されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。`
  : `→ 毎日03:00のoff-peak帯に半額(約50%off)で実行されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。`);
console.log(`→ 今すぐ実行したい場合: node batch-run.mjs --force`);
