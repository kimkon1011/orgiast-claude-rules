#!/usr/bin/env node
/**
 * render-cloud.mjs — BlenderレンダリングをクラウドGPU（RunPod/Vast.ai）へ委譲するラッパー。
 *
 * 使い方:
 *   node tools/render-cloud.mjs --blend input.blend --output ./renders/ [--script render.py] [--engine CYCLES] [--frames 1..120] [--mode cloud|local|auto]
 *
 * 環境変数:
 *   CLOUD_RENDER_PROVIDER   runpod または vast （既定: 未設定＝local/auto時のみ）
 *   RUNPOD_API_KEY          RunPod API キー（Serverless用）
 *   VAST_API_KEY            Vast.ai API キー
 *   RENDER_CLOUD_TIMEOUT    タイムアウト秒（既定 600）
 *   RENDER_CLOUD_FALLBACK   local|abort（既定: local — クラウド失敗時にローカルでフォールバック）
 *
 * モード:
 *   cloud  クラウドGPUで強制実行（鍵が無ければエラー）
 *   local  ローカルBlenderで実行（既定）
 *   auto   クラウドを試み、失敗/鍵なしならローカルへフォールバック
 *
 * SSD書き込み削減効果:
 *   クラウド実行時、レンダリング中間ファイル（フレームバッファ・シミュレーション
 *   キャッシュ・テンポラリ）はクラウド側のストレージに留まり、ローカルSSDへの
 *   書き込みはゼロ。完成品（PNG/MP4）のみがダウンロードされる。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// --------------- config ---------------

const ENV = {
  provider: process.env.CLOUD_RENDER_PROVIDER ?? '',
  runpodKey: process.env.RUNPOD_API_KEY ?? '',
  vastKey: process.env.VAST_API_KEY ?? '',
  timeout: parseInt(process.env.RENDER_CLOUD_TIMEOUT ?? '600', 10),
  fallback: process.env.RENDER_CLOUD_FALLBACK ?? 'local',
};

const RUNTIME_ENV_KEYS = ['CLOUD_RENDER_PROVIDER', 'RUNPOD_API_KEY', 'VAST_API_KEY', 'RENDER_CLOUD_TIMEOUT', 'RENDER_CLOUD_FALLBACK'];

// --------------- helpers ---------------

function log(...args) { console.error('[render-cloud]', ...args); }

function bail(msg, code = 1) { log(`FATAL: ${msg}`); process.exit(code); }

function ensureBlender() {
  const candidate = process.env.BOOTH3D_BLENDER || path.join(process.env.USERPROFILE ?? '', 'tools', 'blender', 'blender.exe');
  if (existsSync(candidate)) return candidate;
  // 標準PATH探索
  try {
    const r = execSync('where blender 2>nul || which blender 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const p = r.split(/\r?\n/).filter(Boolean)[0];
    if (p) return p;
  } catch { /* not found */ }
  return null;
}

function hasLocalBlender() {
  const p = ensureBlender();
  if (!p) { log('ローカルBlenderが見つかりません。BOOTH3D_BLENDER 環境変数を設定するか、tools/booth-3d/ensure-blender.mjs でインストールしてください。'); return false; }
  return p;
}

function hasCloudCreds(provider) {
  if (provider === 'runpod') return !!ENV.runpodKey;
  if (provider === 'vast') return !!ENV.vastKey;
  return false;
}

/** クラウドレンダリングのコスト見積もりを1行で出力 */
function costEstimate(mode, engine, frames) {
  const fps = 24;
  const frameCount = typeof frames === 'string' ? (() => {
    const m = frames.match(/^(\d+)\.\.(\d+)$/);
    return m ? parseInt(m[2], 10) - parseInt(m[1], 10) + 1 : 1;
  })() : (frames ?? 1);
  if (mode === 'local') {
    log(`[cost] local render: 0 USD (electricity + SSD wear only)`);
    log(`[cost] SSD write estimate: ~${(frameCount * 5).toFixed(0)} MB (intermediate + output)`);
    return;
  }
  const pricePerFrame = engine?.toUpperCase() === 'CYCLES' ? 0.03 : 0.01;
  const est = (frameCount * pricePerFrame).toFixed(3);
  log(`[cost] cloud render (RTX 4090 ~$0.34/h): ~$${est} for ${frameCount} frames`);
  log(`[cost] SSD write avoided: ~${(frameCount * 50).toFixed(0)} MB (all temp/cache on cloud side)`);
}

// --------------- local render ---------------

function renderLocal({ blend, script, output, engine, frames, device, extraArgs = [], blenderPath }) {
  const blender = blenderPath || ensureBlender();
  if (!blender) bail('ローカルBlenderが利用できません');
  mkdirSync(output, { recursive: true });

  const args = ['--background', blend];
  if (script) args.push('--python', script);
  if (engine) args.push('--engine', engine);
  if (frames) args.push('--render-frame', frames.toString());
  if (device) args.push('--cycles-device', device);
  if (!script) {
    args.push('-o', path.join(output, 'frame_'));
    args.push('-F', 'PNG');
  }
  if (extraArgs.length) args.push(...extraArgs);

  log(`local blender: ${blender} ${args.join(' ')}`);
  const r = spawnSync(blender, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: ENV.timeout * 1000,
  });
  const success = r.status === 0;
  log(`local blender exit ${r.status}${success ? '' : ` — ${(r.stderr || '').slice(-300)}`}`);
  return { success, mode: 'local', output, blend, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --------------- cloud render (RunPod) ---------------

/** RunPod Serverless でレンダリングを実行（エンドポイント事前登録が必要） */
async function renderRunPod({ blend, script, output, engine, frames }) {
  if (!ENV.runpodKey) bail('RUNPOD_API_KEY が設定されていません');
  mkdirSync(output, { recursive: true });

  // RunPod Serverless エンドポイントの呼び出し
  // 注: 本番利用前に RunPod コンソールで Serverless エンドポイントを作成する必要あり
  log('RunPod Serverless へジョブ投入...');
  log('注意: RunPod Serverless エンドポイントの事前作成が必要です。');
  log('      未設定の場合は local モードを使うか RENDER_CLOUD_FALLBACK=local を設定してください。');

  // エンドポイントURLは環境変数または既定値
  const endpointId = process.env.RUNPOD_ENDPOINT_ID || '';

  if (!endpointId) {
    log('RUNPOD_ENDPOINT_ID が未設定です。');
    return { success: false, mode: 'cloud', error: 'RunPod endpoint not configured', output };
  }

  try {
    const apiUrl = `https://api.runpod.ai/v2/${endpointId}/runsync`;
    const body = JSON.stringify({
      input: {
        blend_data: readFileSync(blend).toString('base64'),
        script_data: script ? readFileSync(script).toString('base64') : '',
        engine: engine ?? 'CYCLES',
        frames: frames ?? 1,
        output_format: 'PNG',
      },
    });

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.runpodKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(ENV.timeout * 1000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    const resultB64 = json.output?.result_base64;
    if (resultB64) {
      const resultPath = path.join(output, 'cloud-render.png');
      writeFileSync(resultPath, Buffer.from(resultB64, 'base64'));
      log(`cloud render saved: ${resultPath}`);
      return { success: true, mode: 'cloud', output, blend, files: [resultPath] };
    }
    throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 300)}`);
  } catch (e) {
    log(`RunPod error: ${e.message || e}`);
    return { success: false, mode: 'cloud', error: String(e.message || e), output };
  }
}

// --------------- cloud render (Vast.ai) ---------------

/** Vast.ai SSH + CLI でレンダリング（事前にインスタンステンプレート設定が必要） */
async function renderVast({ blend, script, output, engine, frames }) {
  if (!ENV.vastKey) bail('VAST_API_KEY が設定されていません');
  log('Vast.ai レンダリングは SSH 経由のセットアップが必要です。');
  log('Vast.ai テンプレート ID を VAST_TEMPLATE_ID 環境変数に設定してください。');
  return { success: false, mode: 'cloud', error: 'Vast.ai not yet integrated', output };
}

// --------------- main ---------------

/** 引数を解析 */
function parseArgs(argv) {
  const opts = { mode: 'local' };
  let provider = ENV.provider || 'runpod';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--blend') { opts.blend = path.resolve(v ?? ''); i += 1; }
    else if (a === '--output') { opts.output = path.resolve(v ?? ''); i += 1; }
    else if (a === '--script') { opts.script = path.resolve(v ?? ''); i += 1; }
    else if (a === '--engine') { opts.engine = v; i += 1; }
    else if (a === '--frames') { opts.frames = v; i += 1; }
    else if (a === '--device') { opts.device = v; i += 1; }
    else if (a === '--mode') {
      const m = (v ?? '').toLowerCase();
      if (!['local', 'cloud', 'auto'].includes(m)) bail(`unknown mode: ${m}`);
      opts.mode = m;
      i += 1;
    }
    else if (a === '--provider') {
      provider = v ?? 'runpod';
      i += 1;
    }
    else if (a === '--help') {
      console.log(`使い方: node tools/render-cloud.mjs --blend <path> --output <dir> [options]

オプション:
  --blend <path>       入力 .blend ファイル（必須）
  --output <dir>       出力ディレクトリ（必須）
  --script <path>      Blender Python スクリプト
  --engine <name>      CYCLES / EEVEE / WORKBENCH
  --frames <range>     例: 1..120
  --device <name>      CUDA / OPTIX / CPU
  --mode <mode>        local / cloud / auto（既定: local）
  --provider <name>    runpod / vast（既定: 環境変数 CLOUD_RENDER_PROVIDER）

環境変数:
  CLOUD_RENDER_PROVIDER  クラウドプロバイダ（runpod / vast）
  RUNPOD_API_KEY         RunPod API キー
  VAST_API_KEY           Vast.ai API キー
  RUNPOD_ENDPOINT_ID     RunPod Serverless エンドポイントID
  RENDER_CLOUD_TIMEOUT   タイムアウト秒（既定 600）
  RENDER_CLOUD_FALLBACK  クラウド失敗時: local / abort（既定 local）`);
      process.exit(0);
    }
    else bail(`不明なオプション: ${a}（--help で一覧）`);
  }
  if (!opts.blend) bail('--blend は必須です');
  if (!opts.output) bail('--output は必須です');
  if (!existsSync(opts.blend)) bail(`.blend ファイルがありません: ${opts.blend}`);
  if (opts.script && !existsSync(opts.script)) bail(`スクリプトがありません: ${opts.script}`);
  opts.provider = provider;
  return opts;
}

export async function renderCloud(opts) {
  costEstimate(opts.mode, opts.engine, opts.frames);

  // local モード: 常にローカル
  if (opts.mode === 'local') {
    return renderLocal(opts);
  }

  // cloud / auto モード
  const provider = opts.provider || 'runpod';
  const hasCreds = hasCloudCreds(provider);

  if (opts.mode === 'cloud') {
    if (!hasCreds) {
      bail(`--mode cloud ですが ${provider} の API キーが未設定です`);
    }
    let result;
    if (provider === 'runpod') result = await renderRunPod(opts);
    else if (provider === 'vast') result = await renderVast(opts);
    else bail(`未知のプロバイダ: ${provider}`);
    if (result.success) return result;
    // クラウド失敗かつ abort なら bail
    if (ENV.fallback === 'abort') bail(`cloud render failed: ${result.error}`);
    // fallback=local ならローカルへ
    log(`cloud render 失敗 (${result.error})、local へフォールバック`);
    return renderLocal(opts);
  }

  // auto モード: クレデンシャルがあればクラウドを試す
  if (hasCreds) {
    log(`auto: cloud credentials found, trying ${provider}...`);
    let result;
    if (provider === 'runpod') result = await renderRunPod(opts);
    else if (provider === 'vast') result = await renderVast(opts);
    else result = { success: false, error: `unknown provider: ${provider}` };
    if (result.success) return result;
    log(`cloud 失敗 (${result.error})、local へフォールバック`);
  } else {
    log(`auto: cloud credentials not found, using local`);
  }
  return renderLocal(opts);
}

export function printResult(result) {
  if (result.success) {
    console.log(JSON.stringify({ ok: true, mode: result.mode, output: result.output, files: result.files ?? [], error: null }));
  } else {
    console.log(JSON.stringify({ ok: false, mode: result.mode, output: result.output, files: [], error: result.error ?? 'unknown' }));
    process.exitCode = 1;
  }
}

// --------------- entry point ---------------

if (isEntry(import.meta.url)) {
  const start = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  renderCloud(opts).then((result) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`completed in ${elapsed}s`);
    printResult(result);
  }).catch((e) => {
    log(`unhandled error: ${e.message || e}`);
    process.exit(1);
  });
}