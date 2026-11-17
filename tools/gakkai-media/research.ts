import { findByName } from './media-master.ts';

interface ResearchResult {
  media_name: string;
  monthly_plan: { description: string; cost_yen_per_month: number };
  min_spot_cost_yen: number;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function valid(value: unknown): value is ResearchResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ResearchResult>;
  return typeof item.media_name === 'string' && !!item.monthly_plan &&
    typeof item.monthly_plan.description === 'string' && typeof item.monthly_plan.cost_yen_per_month === 'number' &&
    typeof item.min_spot_cost_yen === 'number' && ['high', 'medium', 'low'].includes(String(item.confidence)) &&
    typeof item.notes === 'string';
}

function parseResponse(text: string): ResearchResult | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value: unknown = JSON.parse(cleaned);
    return valid(value) ? value : undefined;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      const value: unknown = JSON.parse(match[0]);
      return valid(value) ? value : undefined;
    } catch { return undefined; }
  }
}

async function research(mediaName: string, apiKey: string): Promise<ResearchResult | undefined> {
  const prompt = `あなたは日本の広告料金に詳しいアナリストです。${mediaName}の2026年11月時点の広告料金相場を教えてください。想定配信: 5秒スポット(CM)。以下のJSONのみ回答: { "media_name": "...", "monthly_plan": { "description": "...", "cost_yen_per_month": 数値 }, "min_spot_cost_yen": 数値, "confidence": "high|medium|low", "notes": "..." }`;
  let parseFailures = 0;
  let rateFailures = 0;
  while (parseFailures <= 2) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 512 } }),
    });
    if (response.status === 429) {
      await sleep(Math.min(60_000, 1_000 * (2 ** rateFailures++)));
      continue;
    }
    if (!response.ok) {
      console.error(`${mediaName}: Gemini API error ${response.status}: ${await response.text()}`);
      return undefined;
    }
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    const result = parseResponse(text);
    if (result) return result;
    parseFailures += 1;
  }
  console.error(`${mediaName}: Gemini response could not be parsed after 3 attempts`);
  return undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: npx tsx tools/gakkai-media/research.ts [--media-master] [media name ...]');
    return;
  }
  const useMaster = process.argv.includes('--media-master');
  const args = process.argv.slice(2).filter((arg) => arg !== '--media-master');
  let stdin = '';
  if (!process.stdin.isTTY) stdin = await readStdin();
  const names = [...stdin.split(/\r?\n/), ...args].map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return;
  const selected = useMaster ? names.filter((name) => findByName(name)) : names;
  if (selected.length === 0) return;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY is required'); process.exit(1); }
  for (let index = 0; index < selected.length; index += 1) {
    const result = await research(selected[index], apiKey);
    if (result) console.log(JSON.stringify(result));
    if (index < selected.length - 1) await sleep(500);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
