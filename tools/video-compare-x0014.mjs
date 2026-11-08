import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const MODELS = Object.freeze({
  'kling-4.0': Object.freeze({
    reachable: false,
    reason: 'OpenRouter に無し・fal/Segmind キー無し',
  }),
  'gemini-omni-1.2-flash': Object.freeze({
    reachable: true,
    providerModel: 'google/gemini-omni-1.2-flash',
    pricePerSecondUsd: 0.069504,
  }),
  muse: Object.freeze({
    reachable: false,
    reason: '公式 API なし・APIMart キー無し',
  }),
  'stardream-2.5': Object.freeze({
    reachable: false,
    reason: '実在未確認',
  }),
});

export function estimateCost(modelName, duration, models = MODELS) {
  const model = models[modelName];
  if (!model) throw new Error(`未知のモデル: ${modelName}`);
  if (!model.reachable) return { costUsd: null, reason: model.reason };
  return { costUsd: duration * model.pricePerSecondUsd, reason: null };
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export function planRun({ prompt = '', imagePath = null, imageSha256 = '未指定', duration = 10, budget = 30 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('duration は正の数で指定してください');
  if (!Number.isFinite(budget) || budget < 0) throw new TypeError('budget は 0 以上で指定してください');

  const models = Object.entries(MODELS).map(([name, config]) => {
    const estimate = estimateCost(name, duration);
    return {
      model: name,
      providerModel: config.providerModel ?? null,
      reachable: config.reachable,
      reason: estimate.reason,
      prompt,
      image: imagePath ?? '未指定',
      imageSha256,
      duration,
      estimatedCostUsd: estimate.costUsd,
    };
  });
  const totalEstimatedCostUsd = models.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0);
  const plan = { prompt, image: imagePath ?? '未指定', imageSha256, duration, budgetUsd: budget, models, totalEstimatedCostUsd };
  if (totalEstimatedCostUsd > budget) {
    const error = new RangeError(`見積合計 $${totalEstimatedCostUsd} が予算 $${budget} を超過します`);
    error.plan = plan;
    throw error;
  }
  return plan;
}

export async function probeVideo(path, ffprobe = 'ffprobe') {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,width,height,r_frame_rate',
    '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video') ?? {};
  const [numerator, denominator] = String(video.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    durationSeconds: Number(parsed.format?.duration),
    width: video.width ?? null,
    height: video.height ?? null,
    fps: denominator ? numerator / denominator : null,
    sizeBytes: Number(parsed.format?.size),
    sha256: await sha256File(path),
  };
}

async function generateVideo({ model, prompt, imagePath, duration, outDir, apiKey }) {
  const imageBytes = await readFile(imagePath);
  const extension = basename(imagePath).toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const startedAt = new Date();
  const started = performance.now();
  const response = await fetch('https://openrouter.ai/api/v1/videos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.providerModel,
      prompt,
      duration,
      resolution: '720p',
      image: `data:image/${extension};base64,${imageBytes.toString('base64')}`,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter video API: HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const videoUrl = payload.url ?? payload.data?.[0]?.url ?? payload.output?.url;
  if (!videoUrl) throw new Error('OpenRouter 応答に動画 URL がありません');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) throw new Error(`動画取得: HTTP ${videoResponse.status}`);
  const videoPath = join(outDir, `${model.name}.mp4`);
  await writeFile(videoPath, Buffer.from(await videoResponse.arrayBuffer()));
  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    model: model.name,
    providerModel: model.providerModel,
    startedAt: startedAt.toISOString(),
    elapsedSeconds,
    actualCostUsd: Number(payload.usage?.cost ?? duration * model.pricePerSecondUsd),
    videoPath,
    probe: await probeVideo(videoPath),
  };
}

function parseArgs(argv) {
  const options = { imagePath: null, prompt: '', duration: 10, budget: 30, dryRun: false, outDir: '.loop/x0014-runs' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--image') options.imagePath = argv[++index];
    else if (arg === '--prompt') options.prompt = argv[++index];
    else if (arg === '--duration') options.duration = Number(argv[++index]);
    else if (arg === '--budget') options.budget = Number(argv[++index]);
    else if (arg === '--out') options.outDir = argv[++index];
    else throw new Error(`不明な引数: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const options = parseArgs(argv);
    if (!options.imagePath && options.dryRun) console.error('警告: --image 未指定（dry-run のため計画のみ続行）');
    const imageSha256 = options.imagePath ? await sha256File(options.imagePath) : '未指定';
    const plan = planRun({ ...options, imageSha256 });
    if (options.dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    if (!options.imagePath) throw new Error('非 dry-run では --image が必要です');
    if (!env.OPENROUTER_API_KEY) {
      console.error(JSON.stringify({ error: 'OPENROUTER_API_KEY が未設定です' }));
      return 2;
    }
    const outDir = resolve(options.outDir);
    await mkdir(outDir, { recursive: true });
    let cumulativeCostUsd = 0;
    for (const item of plan.models.filter((candidate) => candidate.reachable)) {
      if (cumulativeCostUsd + item.estimatedCostUsd > options.budget) break;
      const record = await generateVideo({ model: { ...MODELS[item.model], name: item.model }, ...options, outDir, apiKey: env.OPENROUTER_API_KEY });
      cumulativeCostUsd += record.actualCostUsd;
      record.cumulativeCostUsd = cumulativeCostUsd;
      await writeFile(join(outDir, `${item.model}.json`), `${JSON.stringify(record, null, 2)}\n`);
      if (cumulativeCostUsd > options.budget) break;
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...(error.plan ? { plan: error.plan } : {}) }, null, 2));
    return 1;
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exitCode = await main();
