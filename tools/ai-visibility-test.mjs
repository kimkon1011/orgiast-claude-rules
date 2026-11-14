// AI Visibility Test Tool — PHASE1 Hack for X-0007
// Tests orgiast.jp against 100 buyer-intent prompts via LLM API
// Usage: node tools/ai-visibility-test.mjs [--from N] [--to N] [--skip-existing] [--limit N] [--sample 1,2,3]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = 'C:/Users/kimko/.claude/auto-session-repo';
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
  let limit = 0; let sample = null; let fromId = 0; let toId = 0; let skipExisting = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) limit = parseInt(args[++i], 10);
    if (args[i] === '--sample' && i + 1 < args.length) sample = args[++i].split(',').map(Number);
    if (args[i] === '--from' && i + 1 < args.length) fromId = parseInt(args[++i], 10);
    if (args[i] === '--to' && i + 1 < args.length) toId = parseInt(args[++i], 10);
    if (args[i] === '--skip-existing') skipExisting = true;
  }
  return { limit, sample, fromId, toId, skipExisting };
}

// Append one row to CSV, deduplicating by ID on write
function appendResult(id, category, prompt, cited, urls, error, response_length, preview) {
  const escPrompt = prompt.replace(/"/g, '""');
  const escPreview = preview.replace(/"/g, "'");
  const row = `"${id}","${category}","${escPrompt}","${cited}","${urls}","${error}",${response_length},"${escPreview}"`;
  if (!fs.existsSync(DEFAULT_OUT)) {
    const h = 'id,category,prompt,cited,urls,error,response_length,preview';
    fs.writeFileSync(DEFAULT_OUT, '\uFEFF' + h + '\n' + row + '\n', 'utf8');
  } else {
    // Append and deduplicate
    fs.appendFileSync(DEFAULT_OUT, row + '\n', 'utf8');
    const raw = fs.readFileSync(DEFAULT_OUT, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return;
    const header = lines[0];
    const seen = new Set();
    const deduped = [header];
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^"(\d+)"/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      deduped.push(lines[i]);
    }
    fs.writeFileSync(DEFAULT_OUT, deduped.join('\n') + '\n', 'utf8');
  }
}

async function main() {
  const { limit, sample, fromId, toId, skipExisting } = parseArgs();

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
  else {
    if (fromId > 0) rows = rows.filter(r => r.id >= fromId);
    if (toId > 0) rows = rows.filter(r => r.id <= toId);
    if (limit > 0 && limit < rows.length) rows = rows.slice(0, limit);
  }

  // Skip already-tested prompts
  if (skipExisting && fs.existsSync(DEFAULT_OUT)) {
    const existingRaw = fs.readFileSync(DEFAULT_OUT, 'utf8');
    const existingIds = new Set(existingRaw.split('\n').slice(1).filter(Boolean).map(l => {
      const m = l.match(/^"(\d+)"/); return m ? parseInt(m[1], 10) : null;
    }).filter(Boolean));
    const before = rows.length;
    rows = rows.filter(r => !existingIds.has(r.id));
    console.log(`Skipping ${before - rows.length} already-tested prompts. Remaining: ${rows.length}`);
  }

  console.log(`Testing ${rows.length} prompts against LLM (openrouter/openai/gpt-oss-120b)`);
  console.log(`Target: orgiast.jp`);
  console.log('---');

  let cited = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(`[${i+1}/${rows.length}] #${row.id} ${row.prompt.slice(0, 40)}... `);

    const { text, error } = await queryLlm(row.prompt);
    const hasOrgiast = containsOrgiast(text);
    const urls = extractUrls(text);
    if (hasOrgiast) cited++;

    // Save incrementally
    appendResult(
      row.id, row.category, row.prompt,
      hasOrgiast ? 'Y' : 'N',
      urls.join('; ').slice(0, 200),
      error || '',
      text.length,
      text.slice(0, 150).replace(/"/g, "'").replace(/\n/g, ' '));

    console.log(hasOrgiast ? '✅' : '❌');
  }

  // Summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Tested: rows processed`);
  console.log(`Orgiast cited in: ${cited}/${rows.length} (${rows.length > 0 ? (cited / rows.length * 100).toFixed(1) : '0.0'}%)`);

  const totalResults = fs.existsSync(DEFAULT_OUT)
    ? fs.readFileSync(DEFAULT_OUT, 'utf8').split('\n').slice(1).filter(Boolean).length : 0;
  console.log(`Total results in CSV: ${totalResults}`);
  console.log(`\nResults saved: ${DEFAULT_OUT}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });