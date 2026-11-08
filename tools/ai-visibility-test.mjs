// AI Visibility Test Tool — PHASE1 Hack for X-0007
// Tests orgiast.jp against 100 buyer-intent prompts via LLM API
// Usage: node tools/ai-visibility-test.mjs [--limit N] [--sample 1,2,3]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.cwd();
const PROMPTS_CSV = path.join(REPO, 'ai-visibility', 'prompts-100.csv');
const DEFAULT_OUT = path.join(REPO, 'ai-visibility', 'results-20261108.csv');

const ORGIAST_IDS = ['オージャスト','orgiast','Orgiast','tetsuko.co.jp','orgiast.jp','event-shop.jp','rebooth.co.jp','orgiast-product.jp'];

function containsOrgiast(text) {
  const lower = text.toLowerCase();
  return ORGIAST_IDS.some(id => lower.includes(id.toLowerCase()));
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s"'）\)、,.\u3000!?;:>]+/g)].map(m => m[0]).filter(u => u.length > 10);
}

async function queryLlm(prompt) {
  return new Promise((resolve) => {
    const proc = spawn('node', [
      path.join(REPO, 'tools/llm-ask.mjs'),
      '--provider', 'openrouter',
      '--per-provider-timeout-ms', '20000',
      '--max', '1024',
      prompt,
    ], { cwd: REPO, timeout: 30000 });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ text: out.trim(), error: 'timeout' });
    }, 28000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ text: out.trim(), error: code !== 0 ? `exit_${code}` : null });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ text: '', error: e.message });
    });
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; let sample = null; let offset = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) limit = parseInt(args[++i], 10);
    if (args[i] === '--sample' && i + 1 < args.length) sample = args[++i].split(',').map(Number);
    if (args[i] === '--offset' && i + 1 < args.length) offset = parseInt(args[++i], 10);
  }
  return { limit, sample, offset };
}

async function main() {
  const { limit, sample, offset } = parseArgs();

  // Read prompts CSV (BOM-aware)
  let raw = fs.readFileSync(PROMPTS_CSV, 'utf8').trim();
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const lines = raw.split('\n');

  // Parse CSV rows
  let rows = lines.slice(1).filter(Boolean).map(line => {
    const parts = [];
    let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    return {
      id: parseInt(parts[0] || '0', 10),
      category: parts[1] || '',
      base_q: parts[2] || '',
      variation: parts[3] || '',
      prompt: (parts.slice(4).join(' ') || '').replace(/\s+/g, ' ').trim(),
    };
  });

  if (sample) rows = rows.filter(r => sample.includes(r.id));
  else if (offset > 0) rows = rows.filter(r => r.id > offset);
  if (limit > 0 && limit < rows.length) rows = rows.slice(0, limit);

  console.log(`Testing ${rows.length} prompts against LLM (openrouter/openai/gpt-oss-120b)`);
  console.log(`Target: orgiast.jp`);
  console.log('---');

  const results = [];
  let cited = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(`[${i+1}/${rows.length}] #${row.id} ${row.prompt.slice(0, 40)}... `);

    const { text, error } = await queryLlm(row.prompt);
    const hasOrgiast = containsOrgiast(text);
    const urls = extractUrls(text);
    if (hasOrgiast) cited++;

    results.push({
      id: row.id, category: row.category, prompt: row.prompt,
      cited: hasOrgiast ? 'Y' : 'N',
      urls: urls.join('; ').slice(0, 200),
      error: error || '',
      response_length: text.length,
      preview: text.slice(0, 150).replace(/"/g, "'").replace(/\n/g, ' '),
    });
    console.log(hasOrgiast ? '✅' : '❌');
  }

  // Write CSV
  const h = 'id,category,prompt,cited,urls,error,response_length,preview';
  const outRows = results.map(r =>
    `"${r.id}","${r.category}","${r.prompt.replace(/"/g,'""')}","${r.cited}","${r.urls}","${r.error}",${r.response_length},"${r.preview}"`);
  fs.writeFileSync(DEFAULT_OUT, '\uFEFF' + h + '\n' + outRows.join('\n'), 'utf8');

  // Summary
  const pct = results.length > 0 ? (cited / results.length * 100).toFixed(1) : '0.0';
  console.log(`\n=== SUMMARY ===`);
  console.log(`Tested: ${results.length} prompts`);
  console.log(`Orgiast cited in: ${cited}/${results.length} (${pct}%)`);

  const cats = {};
  for (const r of results) {
    cats[r.category] = cats[r.category] || { t:0, c:0 };
    cats[r.category].t++; if (r.cited === 'Y') cats[r.category].c++;
  }
  for (const [cat, s] of Object.entries(cats)) {
    console.log(`  ${cat}: ${s.c}/${s.t} (${(s.c/s.t*100).toFixed(1)}%)`);
  }
  console.log(`\nResults saved: ${DEFAULT_OUT}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });