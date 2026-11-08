import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const API_BASE = 'https://openrouter.ai/api/v1';
const MODEL = 'gemini-omni-1.2-flash';
const PROVIDER_MODEL = 'google/gemini-omni-1.2-flash';
const RATE = 0.069504;
const MAX_ESTIMATE = 0.6950;
const HARD_BUDGET = 1.00;
const EXPECTED_IMAGE_HASH = 'f3d08cd590f67cd194c8f28a8f7335b7891c490b65997dd3075bcfb991572ce4';
const FFPROBE = 'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe';

export const MODELS = Object.freeze({
  'kling-4.0': { reachable: false, reason: 'OpenRouter に無し・fal/Segmind キー無し' },
  [MODEL]: { reachable: true, providerModel: PROVIDER_MODEL, pricePerSecondUsd: RATE },
  muse: { reachable: false, reason: '公式 API なし・APIMart キー無し' },
  'stardream-2.5': { reachable: false, reason: '実在未確認' },
});
const round4 = (n) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function estimateCost(name, duration, models = MODELS) {
  const model = models[name];
  if (!model) throw new Error(`未知のモデル: ${name}`);
  return model.reachable ? { costUsd: duration * model.pricePerSecondUsd, reason: null } : { costUsd: null, reason: model.reason };
}
export async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }

export function planRun({ prompt = '', imagePath = null, imageSha256 = '未指定', duration = 10, budget = HARD_BUDGET } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('duration は正の数で指定してください');
  if (!Number.isFinite(budget) || budget < 0 || budget > HARD_BUDGET) throw new RangeError(`budget は $${HARD_BUDGET.toFixed(2)} 以下で指定してください`);
  const models = Object.entries(MODELS).map(([name, config]) => { const e = estimateCost(name, duration); return { model: name, providerModel: config.providerModel ?? null, reachable: config.reachable, reason: e.reason, prompt, image: imagePath ?? '未指定', imageSha256, duration, estimatedCostUsd: e.costUsd }; });
  const totalEstimatedCostUsd = models.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
  const plan = { prompt, image: imagePath ?? '未指定', imageSha256, duration, resolution: '720p', budgetUsd: budget, models, totalEstimatedCostUsd };
  if (round4(totalEstimatedCostUsd) > MAX_ESTIMATE || totalEstimatedCostUsd > budget) { const error = new RangeError(`見積 $${round4(totalEstimatedCostUsd).toFixed(4)} が許容見積 $${MAX_ESTIMATE.toFixed(4)} または予算 $${budget.toFixed(2)} を超過します`); error.plan = plan; throw error; }
  return plan;
}

export async function probeVideo(path, ffprobe = process.env.X0014_FFPROBE || FFPROBE) {
  const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', path]);
  return JSON.parse(stdout);
}
function envValue(text, name) { return String(text).match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^\\s"']+)`, 'm'))?.[1] ?? null; }
export async function loadOpenRouterKey(home = os.homedir(), env = process.env) { return env.OPENROUTER_API_KEY || envValue(await readFile(join(home, '.claude', 'openrouter.env'), 'utf8'), 'OPENROUTER_API_KEY'); }
const sanitized = (text) => String(text).replace(/sk-or-[A-Za-z0-9_-]+/g, '[REDACTED]');

async function api(fetchImpl, url, key, init = {}) {
  const response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const text = await response.text();
  if (!response.ok) { const error = new Error(`HTTP ${response.status}: ${sanitized(text)}`); error.response = { status: response.status, body: sanitized(text) }; throw error; }
  return text ? JSON.parse(text) : {};
}

export async function generateVideo({ apiKey, prompt, imagePath, duration = 10, outDir, fetchImpl = fetch, sleepImpl = sleep, pollMilliseconds = 30000, maxPolls = 60, probeImpl = probeVideo }) {
  const bytes = await readFile(imagePath); const mime = basename(imagePath).toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const request = { model: PROVIDER_MODEL, prompt, duration, resolution: '720p', frame_images: [{ frame_type: 'first_frame', input_image: `data:${mime};base64,${bytes.toString('base64')}` }] };
  const startedAt = new Date(); const started = performance.now(); let submitted; let job;
  // Two submissions maximum; after an id is accepted, only that job is polled to avoid duplicate charges.
  for (let attempt = 1; attempt <= 2; attempt++) { try { submitted = await api(fetchImpl, `${API_BASE}/videos`, apiKey, { method: 'POST', body: JSON.stringify(request) }); break; } catch (error) { if (attempt === 2 || (error.response?.status ?? 0) < 500) throw error; } }
  if (!submitted?.id) throw new Error(`submit 応答に job id がありません: ${sanitized(JSON.stringify(submitted))}`);
  const pollingUrl = new URL(submitted.polling_url || `${API_BASE}/videos/${encodeURIComponent(submitted.id)}`, API_BASE).href;
  for (let count = 0; count < maxPolls; count++) { job = await api(fetchImpl, pollingUrl, apiKey); if (job.status === 'completed') break; if (['failed', 'cancelled', 'expired'].includes(job.status)) { const error = new Error(`動画ジョブ ${job.status}: ${sanitized(JSON.stringify(job))}`); error.response = job; throw error; } await sleepImpl(pollMilliseconds); }
  if (job?.status !== 'completed') throw new Error(`動画ジョブの poll が上限 ${maxPolls} 回に達しました`);
  const contentUrl = new URL(job.unsigned_urls?.[0] || `${API_BASE}/videos/${encodeURIComponent(job.id || submitted.id)}/content?index=0`, API_BASE).href;
  const videoResponse = await fetchImpl(contentUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!videoResponse.ok) throw new Error(`動画取得 HTTP ${videoResponse.status}: ${sanitized(await videoResponse.text())}`);
  const videoPath = join(outDir, `${MODEL}.mp4`); await writeFile(videoPath, Buffer.from(await videoResponse.arrayBuffer()));
  return { request: { model: request.model, promptSha256: createHash('sha256').update(prompt).digest('hex'), imageSha256: await sha256File(imagePath), duration, resolution: '720p', frameType: 'first_frame' }, jobId: submitted.id, generationId: job.generation_id ?? submitted.generation_id ?? null, actualCostUsd: Number(job.usage?.cost ?? submitted.usage?.cost), usage: job.usage ?? submitted.usage ?? null, startedAt: startedAt.toISOString(), elapsedSeconds: (performance.now() - started) / 1000, sha256: await sha256File(videoPath), ffprobe: await probeImpl(videoPath) };
}

function parseArgs(argv) {
  const o = { imagePath: '.loop/x0014-runs/ref.jpg', promptFile: '.loop/x0014-runs/c1-prompt.txt', duration: 10, budget: HARD_BUDGET, dryRun: false, run: false, model: null, outDir: '.loop/x0014-runs' };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--dry-run') o.dryRun = true; else if (a === '--run') o.run = true; else if (a === '--model') o.model = argv[++i]; else if (a === '--image') o.imagePath = argv[++i]; else if (a === '--prompt-file') o.promptFile = argv[++i]; else if (a === '--duration') o.duration = Number(argv[++i]); else if (a === '--budget') o.budget = Number(argv[++i]); else if (a === '--out') o.outDir = argv[++i]; else throw new Error(`不明な引数: ${a}`); }
  if (o.run && o.dryRun) throw new Error('--run と --dry-run は同時指定できません'); if (o.run && o.model !== 'gemini') throw new Error('--run には --model gemini が必要です'); return o;
}
export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  let outDir = resolve('.loop/x0014-runs');
  try { const o = parseArgs(argv); outDir = resolve(o.outDir); const prompt = await readFile(o.promptFile, 'utf8'); const imageSha256 = await sha256File(o.imagePath); if (o.run && imageSha256 !== EXPECTED_IMAGE_HASH) throw new Error(`参考画像 SHA-256 不一致: ${imageSha256}`); const plan = planRun({ prompt, imagePath: o.imagePath, imageSha256, duration: o.duration, budget: o.budget }); if (o.dryRun || !o.run) { console.log(JSON.stringify(plan, null, 2)); return 0; } await mkdir(outDir, { recursive: true }); const apiKey = await loadOpenRouterKey(os.homedir(), env); if (!apiKey) throw new Error('OPENROUTER_API_KEY が ~/.claude/openrouter.env にありません'); const record = await generateVideo({ apiKey, prompt, imagePath: o.imagePath, duration: o.duration, outDir, ...dependencies }); if (!Number.isFinite(record.actualCostUsd)) throw new Error('API 応答に usage.cost がありません'); if (record.actualCostUsd > HARD_BUDGET) throw new Error(`実コスト $${record.actualCostUsd} が上限 $${HARD_BUDGET.toFixed(2)} を超過しました`); await writeFile(join(outDir, `${MODEL}.json`), `${JSON.stringify(record, null, 2)}\n`); console.log(JSON.stringify(record, null, 2)); return 0; }
  catch (error) { await mkdir(outDir, { recursive: true }); const failure = { error: sanitized(error.message), response: error.response ?? null, at: new Date().toISOString() }; await writeFile(join(outDir, 'gemini-error.json'), `${JSON.stringify(failure, null, 2)}\n`); console.error(JSON.stringify(failure, null, 2)); return 1; }
}
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); if (isCli) process.exitCode = await main();
