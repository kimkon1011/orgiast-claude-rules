import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE;
const dir = path.join(HOME, '.claude', 'projects');

const total = { input_tokens: 0, output_tokens: 0, cache_creation: 0, cache_read: 0 };
const days = {};
const models = {};
const topSessions = {};
const projects = {};

function walk(d, projName) {
  try {
    for (const e of fs.readdirSync(d)) {
      const fp = path.join(d, e);
      const st = fs.statSync(fp);
      if (st.isDirectory()) {
        walk(fp, projName || e);
      } else if (e.endsWith('.jsonl')) {
        parse(fp, projName);
      }
    }
  } catch(e) { /* skip */ }
}

function parse(fp, projName) {
  try {
    const content = fs.readFileSync(fp, { encoding: 'utf8' });
    const lines = content.split('\n').filter(l => l.trim());
    let sessionId = path.basename(fp).replace('.jsonl','');

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const msg = obj?.message;
        const usage = msg?.usage;
        if (usage?.input_tokens && usage.input_tokens > 0) {
          const u = usage;
          const dt = obj.timestamp ? obj.timestamp.substring(0,10) : 'unknown';
          const model = msg?.model || 'unknown';

          if (!days[dt]) days[dt] = { input_tokens:0, output_tokens:0, cache_creation:0, cache_read:0 };
          if (!models[model]) models[model] = { input_tokens:0, output_tokens:0, cache_read:0 };
          if (!topSessions[sessionId]) topSessions[sessionId] = { model, proj: projName || '?', input_tokens:0, output_tokens:0 };
          if (!projects[projName]) projects[projName] = { input_tokens:0, output_tokens:0, cache_read:0, sessions: new Set() };

          days[dt].input_tokens += u.input_tokens;
          days[dt].output_tokens += u.output_tokens || 0;
          days[dt].cache_creation += u.cache_creation_input_tokens || 0;
          days[dt].cache_read += u.cache_read_input_tokens || 0;

          models[model].input_tokens += u.input_tokens;
          models[model].output_tokens += u.output_tokens || 0;
          models[model].cache_read += u.cache_read_input_tokens || 0;

          topSessions[sessionId].input_tokens += u.input_tokens;
          topSessions[sessionId].output_tokens += u.output_tokens || 0;

          projects[projName].input_tokens += u.input_tokens;
          projects[projName].output_tokens += u.output_tokens || 0;
          projects[projName].cache_read += u.cache_read_input_tokens || 0;
          projects[projName].sessions.add(sessionId);

          total.input_tokens += u.input_tokens;
          total.output_tokens += u.output_tokens || 0;
          total.cache_creation += u.cache_creation_input_tokens || 0;
          total.cache_read += u.cache_read_input_tokens || 0;
        }
      } catch(e) { /* parse error */ }
    }
  } catch(e) { /* file error */ }
}

walk(dir, null);

function costSonnet(input, output, cacheRead) {
  return (input/1000*0.003 + output/1000*0.015 + cacheRead/1000*0.0003);
}

function costOpus(input, output, cacheRead) {
  return (input/1000*0.015 + output/1000*0.075 + cacheRead/1000*0.0015);
}

const lines = [];
lines.push('# Phase 0 Baseline');
lines.push('# Generated: ' + new Date().toISOString());
lines.push('# PC: DELL/作業用014');
lines.push('');

lines.push('[metadata]');
lines.push('date=' + new Date().toISOString().substring(0,10));
lines.push('pc=DELL/作業用014');
lines.push('');

lines.push('[daily]');
lines.push('date\tinput_tokens\toutput_tokens\tcache_creation\tcache_read');
const sorted = Object.keys(days).sort();
for (const d of sorted) {
  const day = days[d];
  lines.push(d + '\t' + day.input_tokens + '\t' + day.output_tokens + '\t' + day.cache_creation + '\t' + day.cache_read);
}
lines.push('');

lines.push('[model]');
lines.push('model\tinput_tokens\toutput_tokens\tcache_read\test_sonnet_usd\test_opus_usd');
const sortedModels = Object.entries(models).sort((a,b) => (b[1].output_tokens) - (a[1].output_tokens));
for (const [m, data] of sortedModels) {
  const sCost = costSonnet(data.input_tokens, data.output_tokens, data.cache_read);
  const oCost = costOpus(data.input_tokens, data.output_tokens, data.cache_read);
  lines.push(m + '\t' + data.input_tokens + '\t' + data.output_tokens + '\t' + data.cache_read + '\t' + sCost.toFixed(2) + '\t' + oCost.toFixed(2));
}
lines.push('');

lines.push('[project]');
lines.push('project\tinput_tokens\toutput_tokens\tsessions');
const sortedProjs = Object.entries(projects).sort((a,b) => (b[1].output_tokens) - (a[1].output_tokens));
for (const [p, data] of sortedProjs) {
  lines.push(p + '\t' + data.input_tokens + '\t' + data.output_tokens + '\t' + data.sessions.size);
}
lines.push('');

lines.push('[top-sessions]');
lines.push('session\tmodel\tproject\toutput_tokens');
const sortedSessions = Object.entries(topSessions)
  .map(([id, data]) => ({ id: id.slice(0,12), model: data.model, proj: data.proj, output_tokens: data.output_tokens }))
  .sort((a, b) => b.output_tokens - a.output_tokens)
  .slice(0, 20);
for (const s of sortedSessions) {
  lines.push(s.id + '\t' + s.model + '\t' + (s.proj||'?').slice(0,40) + '\t' + s.output_tokens);
}
lines.push('');

const totS = costSonnet(total.input_tokens, total.output_tokens, total.cache_read);
const totO = costOpus(total.input_tokens, total.output_tokens, total.cache_read);
lines.push('[totals]');
lines.push('input_tokens\t' + total.input_tokens);
lines.push('output_tokens\t' + total.output_tokens);
lines.push('cache_creation\t' + total.cache_creation);
lines.push('cache_read\t' + total.cache_read);
lines.push('est_cost_sonnet\t' + totS.toFixed(2));
lines.push('est_cost_opus\t' + totO.toFixed(2));

fs.writeFileSync('C:/Users/USER/.claude/quota-sweep-repo/tmp/baseline.tsv', lines.join('\n'), 'utf8');
console.log('Baseline TSV saved.');
console.log('');

console.log('=== Corrected Cost Estimates ===');
console.log('Sonnet list pricing: ~$' + totS.toFixed(2));
console.log('Opus list pricing:   ~$' + totO.toFixed(2));
console.log('');

const opusOutput = (models['claude-opus-4-8']?.output_tokens||0) + (models['claude-opus-4-7']?.output_tokens||0) + (models['claude-opus-5-5']?.output_tokens||0);
const sonnetOutput = (models['claude-sonnet-5-5']?.output_tokens||0) + (models['claude-sonnet-5']?.output_tokens||0);
const totalOut = total.output_tokens;

console.log('=== Key Waste Patterns ===');
console.log('1. Output verbosity: ' + (totalOut/1000).toFixed(0) + 'K output tokens = ~$' + (totalOut/1000*0.015).toFixed(2) + ' (Sonnet output cost)');
console.log('2. Cache re-read: ' + (total.cache_read/1000).toFixed(0) + 'K cache reads = ~$' + (total.cache_read/1000*0.0003).toFixed(2) + ' (Sonnet cache cost)');
console.log('3. Opus dominance: ' + (opusOutput * 100 / totalOut).toFixed(0) + '% of output on Opus vs ' + (sonnetOutput * 100 / totalOut).toFixed(0) + '% on Sonnet');
console.log('');

console.log('=== Recommended Tool Priority (data-driven) ===');
console.log('P1: token-optimizer-mcp to reduce cache_read (' + (total.cache_read/1000).toFixed(0) + 'K)');
console.log('P2: caveman to compress output (' + (totalOut/1000).toFixed(0) + 'K output tokens)');
console.log('P3: model-switch advisory (Opus ' + (opusOutput*100/totalOut).toFixed(0) + '% - use --advisor opus --model sonnet)');
console.log('P4 (low): token-savior/serena for input reduction (only ' + (total.input_tokens/1000).toFixed(0) + 'K input tokens)');