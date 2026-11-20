#!/usr/bin/env node
/**
 * Run draft LLMs for proposal/estimate prompts.
 * Usage:
 *   node tools/run_draft_llms.mjs --date YYYY-MM-DD [slug ...]
 *   node tools/run_draft_llms.mjs --date YYYY-MM-DD --slugs a,b,c
 * Legacy (no args): 2026-11-20 + three hard-coded slugs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const llm = 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\llm-ask.mjs';
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const date = flag('--date') || '2026-11-20';
const slugsFlag = flag('--slugs');
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--date' && args[i - 1] !== '--slugs');
let slugs = [];
if (slugsFlag) slugs = slugsFlag.split(',').map((s) => s.trim()).filter(Boolean);
else if (positional.length) slugs = positional;
else if (!args.includes('--date') && !slugsFlag) {
  slugs = ['kagawa-dentoukougei', 'wakayama-police-kunren', 'shimonoseki-kankyo-douga'];
}

const providers = ['deepseek', 'openrouter', 'kimi'];
const outBase = path.join(root, 'reports/drafts', date);

for (const slug of slugs) {
  const dir = path.join(outBase, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of ['proposal', 'estimate']) {
    const prompt = path.join(root, 'prompts/drafts', `${slug}-${kind}.md`);
    if (!fs.existsSync(prompt)) {
      console.error(`${slug}/${kind}: missing prompt ${prompt}`);
      process.exitCode = 1;
      continue;
    }
    let done = false;
    for (const provider of providers) {
      const r = spawnSync(
        process.execPath,
        [llm, '--provider', provider, '--prompt-file', prompt, '--no-fallback', '--max', '7000', '--per-provider-timeout-ms', '180000'],
        { cwd: root, encoding: 'utf8', timeout: 200000, maxBuffer: 20 * 1024 * 1024 },
      );
      if (r.status === 0 && r.stdout.trim().length > 100) {
        fs.writeFileSync(path.join(dir, `${kind}.md`), r.stdout.trim() + '\n', 'utf8');
        console.log(`${slug}/${kind}: ${provider} OK (${r.stdout.length} chars)`);
        done = true;
        break;
      }
      console.error(`${slug}/${kind}: ${provider} failed status=${r.status} ${String(r.stderr || '').slice(0, 500)}`);
    }
    if (!done) process.exitCode = 1;
  }
}
