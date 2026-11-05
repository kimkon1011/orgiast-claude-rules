import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const env = Object.fromEntries(readFileSync(path.join(homedir(), '.claude', 'openrouter.env'), 'utf8').split(/\r?\n/)
  .map((line) => line.match(/^(?:export\s+)?([A-Z_0-9]+)\s*=\s*"?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const key = env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY missing');

const prompt = `Inspect this exhibition-booth rendering as a visual scale auditor. Estimate the ratio: (floor-to-highest point of the booth structure, including truss or upper sign) divided by (height of a representative foreground adult standing on the same floor plane). Correct for perspective. Do not use the hall ceiling. Return JSON only with this exact shape: {"ratio":2.1,"boothPixels":420,"personPixels":200,"confidence":"medium","reason":"short explanation"}. ratio must be one number, not a range.`;

const results = [];
for (const file of process.argv.slice(2)) {
  const data = readFileSync(file).toString('base64');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      ] }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const content = json.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''));
  results.push({ file, model: json.model, ...parsed });
}
console.log(JSON.stringify(results, null, 2));
