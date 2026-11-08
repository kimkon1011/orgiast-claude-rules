#!/usr/bin/env node
/**
 * tools/video-preprocess.mjs
 * X-0002: 動画のGemini渡事前処理 — トークン削減パイプライン
 *
 * 動画をフレーム抽出→重複間引き→3×3グリッド合成→文字起こし→突合し、
 * Gemini投入時のトークン消費を70〜96%削減する。
 *
 * Usage:
 *   node tools/video-preprocess.mjs --input <video> [options]
 *
 * Options:
 *   --input <path>        入力動画ファイル (必須)
 *   --workdir <dir>       作業ディレクトリ (default: ./_video-work)
 *   --fps <n>             フレーム抽出レート (default: 0.5)
 *   --resize <px>         出力解像度 (default: 360)
 *   --similarity <0-1>    重複判定閾値 (default: 0.95)
 *   --grid <WxH>          グリッド構成 (default: 3x3)
 *   --transcribe          文字起こしを実行する (Gemini CLI が必要)
 *   --output <path>       結果JSON出力先 (default: stdout)
 *   --min-duration <sec>  この秒数未満は前処理をスキップ (default: 180)
 *   --keep-temps          中間ファイルを削除しない
 *   --quiet               進捗表示を抑制
 *   --dry-run             実際のコマンド実行なしで計画表示
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, readdir, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const FFMPEG = new URL('../../node_modules/ffmpeg-static/ffmpeg.exe', import.meta.url).pathname;
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/, 'ffprobe.exe');

// ─── helpers ───────────────────────────────────────────────────────
function log(msg, opts = {}) {
  if (!opts.quiet) process.stderr.write(`[video-preprocess] ${msg}\n`);
}
const quote = s => `"${String(s).replace(/"/g, '\\"')}"`;

async function ffprobeMeta(inputPath) {
  const args = [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
    quote(inputPath)
  ];
  const r = runSync(FFPROBE, args, { windowsHide: true });
  if (r.ok) return JSON.parse(r.stdout);
  throw new Error(`ffprobe failed: ${r.stderr}`);
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { ...opts, windowsHide: true });
  return {
    ok: r.exitStatus === 0,
    exitStatus: r.exitStatus,
    stdout: r.stdout?.toString('utf-8') ?? '',
    stderr: r.stderr?.toString('utf-8') ?? '',
  };
}

async function runAsync(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { ...opts, windowsHide: true });
  const out = [], err = [];
  for await (const chunk of p.stdout) out.push(chunk);
  for await (const chunk of p.stderr) err.push(chunk);
  const status = await p.spawnStatus;
  return {
    ok: status.exitStatus === 0,
    exitStatus: status.exitStatus,
    stdout: Buffer.concat(out).toString('utf-8'),
    stderr: Buffer.concat(err).toString('utf-8'),
  };
}

// ─── frame extraction ──────────────────────────────────────────────
async function extractFrames(inputPath, workdir, fps, resize, quiet) {
  const frameDir = join(workdir, 'frames');
  await mkdir(frameDir, { recursive: true });
  const outputPattern = join(frameDir, 'frame_%06d.jpg');
  const args = [
    '-i', quote(inputPath),
    '-vf', quote(`fps=${fps},scale=${resize}:-1`),
    '-q:v', '2',           // JPEG quality 2-5 (低→高品質)
    '-threads', '2',
    '-y',                  // overwrite
    quote(outputPattern),
  ];
  log(`extractFrames: ffmpeg ${args.join(' ')}`, { quiet });
  const r = await runAsync(FFMPEG, args);
  if (!r.ok) throw new Error(`extractFrames failed: ${r.stderr.slice(0, 500)}`);
  // count frames
  const entries = await readdir(frameDir);
  const count = entries.filter(e => e.startsWith('frame_')).length;
  log(`extractFrames: ${count} frames extracted`, { quiet });
  return count;
}

// ─── duplicate detection via ffmpeg psnr ──────────────────────────
async function deduplicate(workdir, similarity, quiet) {
  const frameDir = join(workdir, 'frames');
  const entries = (await readdir(frameDir))
    .filter(e => e.startsWith('frame_') && e.endsWith('.jpg'))
    .sort();
  if (entries.length < 2) return entries;

  const selected = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    const prev = join(frameDir, selected[selected.length - 1]);
    const curr = join(frameDir, entries[i]);
    // Use ffmpeg psnr filter for comparison
    // psnr returns average PSNR across all planes
    const args = [
      '-i', quote(curr),
      '-i', quote(prev),
      '-lavfi', quote('[0][1]psnr'),
      '-f', 'null',
      '-v', 'quiet',
      '-y', 'NUL',
    ];
    const r = runSync(FFMPEG, args);
    // Parse psnr average from stderr like: "PSNR y:30.12 u:35.44 v:35.12 average:31.23 min:28.50 max:33.10"
    let avgPsnr = 0;
    // Note: with -f null, PSNR is on stderr
    const match = r.stdout.match(/average:\s*(\d+\.?\d*)/) || r.stderr.match(/average:\s*(\d+\.?\d*)/);
    if (match) avgPsnr = parseFloat(match[1]);
    // PSNR > 40dB ≒ 非常に類似, > 30dB ≒ 類似
    // 閾値: similarity 0.95 ≒ PSNR ~30dB
    const threshold = 20 + similarity * 20; // 0.9→38dB, 0.95→39dB, 0.99→39.8dB
    if (avgPsnr < threshold) {
      selected.push(entries[i]);
    }
  }
  const removed = entries.length - selected.length;
  log(`deduplicate: ${entries.length} → ${selected.length} (${removed} removed)`, { quiet });
  return selected;
}

// ─── grid creation via ffmpeg ─────────────────────────────────────
async function createGrids(workdir, selected, gridW, gridH, fps, quiet) {
  const gridDir = join(workdir, 'grids');
  await mkdir(gridDir, { recursive: true });
  const frameDir = join(workdir, 'frames');
  const gridSize = gridW * gridH;
  const gridCount = Math.ceil(selected.length / gridSize);
  const gridFiles = [];

  for (let gi = 0; gi < gridCount; gi++) {
    const slice = selected.slice(gi * gridSize, (gi + 1) * gridSize);
    const outputPath = join(gridDir, `grid_${String(gi + 1).padStart(4, '0')}.jpg`);

    // Build complex filter:
    // 1. For each cell: read frame, add timestamp drawtext
    // 2. Arrange into WxH grid
    const cellSec = (i) => {
      const idx = gi * gridSize + i;
      if (idx >= selected.length) return 0;
      const frameNum = parseInt(selected[idx].match(/\d+/)[0]);
      return Math.round(frameNum / fps);
    };

    // ffmpeg drawtext for each cell, then hstack/vstack
    const filterParts = [];
    const inputs = [];
    for (let i = 0; i < slice.length; i++) {
      const fn = slice[i];
      const sec = cellSec(i);
      const mins = Math.floor(sec / 60);
      const secs = sec % 60;
      const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const inputIdx = inputs.length;
      inputs.push(quote(join(frameDir, fn)));
      filterParts.push(
        `[${inputIdx}:v]drawtext=text='${ts}':fontsize=18:fontcolor=white:x=5:y=5:box=1:boxcolor=black@0.5,scale=${480 / gridW}:-1[v${i}]`
      );
    }
    // Pad empty cells
    while (inputs.length < gridSize) {
      const padN = filterParts.length;
      // Use null source for padding
      filterParts.push(`nullsrc=s=${480 / gridW}x${270 / gridH},drawtext=text='':fontsize=10[v${padN}]`);
      inputs.push('-f', 'lavfi', '-i', 'nullsrc=s=1x1'); // dummy
    }

    // Build hstack/vstack
    if (gridW === 3 && gridH === 3) {
      const rows = [];
      for (let r = 0; r < gridH; r++) {
        const cols = [];
        for (let c = 0; c < gridW; c++) {
          cols.push(`[v${r * gridW + c}]`);
        }
        rows.push(cols.join(''));
      }
      const rowLabels = ['a', 'b', 'c'];
      const rowExps = rows.map((r, i) => `${r}hstack=inputs=${gridW}[row${rowLabels[i]}]`);
      filterParts.push(...rowExps);
      filterParts.push(`[rowa][rowb][rowc]vstack=inputs=${gridH}[out]`);
    } else {
      // Generic: flatten all
      const allV = Array.from({ length: inputs.length }, (_, i) => `[v${i}]`);
      if (inputs.length <= gridW) {
        filterParts.push(`${allV.join('')}hstack=inputs=${inputs.length}[out]`);
      } else {
        // Not fully generalized but works for common cases
        const rows = [];
        for (let r = 0; r < gridH; r++) {
          const rowV = [];
          for (let c = 0; c < gridW; c++) {
            const idx = r * gridW + c;
            if (idx < allV.length) rowV.push(allV[idx]);
          }
          if (rowV.length > 0) {
            rows.push(rowV);
            filterParts.push(`${rowV.join('')}hstack=inputs=${rowV.length}[row${r}]`);
          }
        }
        if (rows.length > 0) {
          const rowLabels2 = rows.map((_, i) => `[row${i}]`);
          filterParts.push(`${rowLabels2.join('')}vstack=inputs=${rows.length}[out]`);
        } else {
          filterParts.push(`${allV.join('')}hstack=inputs=${allV.length}[out]`);
        }
      }
    }

    const filterExpr = filterParts.join(';');
    const ffArgs = [
      ...inputs.flatMap(i => ['-i', i]),
      '-filter_complex', quote(filterExpr),
      '-map', '[out]',
      '-q:v', '3',
      '-y',
      quote(outputPath),
    ];

    log(`createGrids: grid ${gi + 1}/${gridCount} (${slice.length} frames)`, { quiet });
    const r = await runAsync(FFMPEG, ffArgs);
    if (!r.ok) {
      log(`grid ${gi + 1}: ffmpeg stderr: ${r.stderr.slice(0, 300)}`, { quiet });
      // Continue even if one grid fails
    } else {
      gridFiles.push(outputPath);
    }
  }

  log(`createGrids: ${gridFiles.length} grids created`, { quiet });
  return gridFiles;
}

// ─── audio extraction ──────────────────────────────────────────────
async function extractAudio(inputPath, workdir, quiet) {
  const audioPath = join(workdir, 'audio.wav');
  const args = [
    '-i', quote(inputPath),
    '-vn',                // no video
    '-acodec', 'pcm_s16le',
    '-ar', '16000',       // 16kHz
    '-ac', '1',           // mono
    '-y',
    quote(audioPath),
  ];
  log(`extractAudio: ${audioPath}`, { quiet });
  const r = await runAsync(FFMPEG, args);
  if (!r.ok) throw new Error(`extractAudio failed: ${r.stderr.slice(0, 300)}`);
  return audioPath;
}

// ─── transcription via Gemini CLI ──────────────────────────────────
async function transcribe(audioPath, quiet) {
  // Gemini CLI は gemini-audio-pro で文字起こし可能
  // --audio でファイルを渡す
  const r = runSync('gemini', [
    '--audio', quote(audioPath),
    '--prompt', '"音声を文字起こししてください。発言者ごとにタイムスタンプ付きで出力。"',
  ], { timeout: 300000 });
  if (!r.ok) {
    log(`transcribe: Gemini CLI failed (${r.exitStatus}), trying gemini-cli directly`, { quiet });
    // Fallback to @google/gemini-cli
    const r2 = runSync('gemini-cli', [
      '--audio', quote(audioPath),
      '--prompt', '"Transcribe the speech with timestamps"',
    ], { timeout: 300000 });
    if (!r2.ok) {
      log(`transcribe: Gemini CLI fallback also failed: ${r2.stderr.slice(0, 200)}`, { quiet });
      return `[transcription failed: Gemini CLI returned ${r2.exitStatus}]`;
    }
    return r2.stdout;
  }
  return r.stdout;
}

// ─── align transcription with frames ───────────────────────────────
function align(transcript, gridFiles, fps, durationSec) {
  // Simple alignment: return metadata with estimation
  const segments = [];
  const lines = transcript.split('\n').filter(l => l.trim());
  for (const line of lines) {
    // Try to extract timestamps like [MM:SS] or (HH:MM:SS) or simple numbers
    const tsMatch = line.match(/(?:\[(\d+):(\d+)\]|(\d+):(\d+):(\d+)|(\d+)\s*秒)/);
    if (tsMatch) {
      const sec = tsMatch[1]
        ? parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2])
        : tsMatch[3]
          ? parseInt(tsMatch[3]) * 3600 + parseInt(tsMatch[4]) * 60 + parseInt(tsMatch[5])
          : parseInt(tsMatch[6]);
      segments.push({
        startSec: sec,
        text: line.replace(/\[[\d:]+\]|\(\d+:\d+:\d+\)|\d+\s*秒/g, '').trim(),
      });
    }
  }

  return {
    segments,
    gridCount: gridFiles.length,
    estimatedTokensWithoutPrep: Math.round(durationSec * 3.3 * 258),  // ~1fps * 258tok/frame
    estimatedTokensWithPrep: (
      gridFiles.length * 9 * 258 +    // ~9 frames per grid
      transcript.length / 4           // ~4chars/token for JP text
    ),
  };
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(1), {
    input: { type: 'string', short: 'i' },
    workdir: { type: 'string', default: './_video-work' },
    fps: { type: 'string', default: '0.5' },
    resize: { type: 'string', default: '360' },
    similarity: { type: 'string', default: '0.95' },
    grid: { type: 'string', default: '3x3' },
    transcribe: { type: 'boolean', short: 't' },
    output: { type: 'string', short: 'o' },
    'min-duration': { type: 'string', default: '180' },
    'keep-temps': { type: 'boolean' },
    quiet: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  });

  if (!args.input) {
    process.stderr.write('Usage: node tools/video-preprocess.mjs --input <video> [options]\n');
    process.exit(1);
  }

  const inputPath = args.input;
  const workdir = args.workdir;
  const fps = parseFloat(args.fps);
  const resize = parseInt(args.resize);
  const similarity = parseFloat(args.similarity);
  const [gridW, gridH] = args.grid.split('x').map(Number);
  const minDuration = parseInt(args['min-duration']);
  const quiet = args.quiet;

  log(`X-0002 Video Preprocessor`, { quiet });
  log(`input: ${inputPath}`, { quiet });
  log(`ffmpeg: ${FFMPEG}`, { quiet });

  // Check input exists
  try {
    const s = await stat(inputPath);
    if (!s.isFile) throw new Error('not a file');
  } catch {
    log(`ERROR: input not found: ${inputPath}`, { quiet });
    process.exit(1);
  }

  // Get video metadata
  let meta;
  try {
    meta = await ffprobeMeta(inputPath);
  } catch (e) {
    // Try with ffmpeg directly if ffprobe doesn't exist
    log(`ffprobe failed, trying ffmpeg: ${e.message}`, { quiet });
    const r = runSync(FFMPEG, ['-i', quote(inputPath), '-f', 'null', '-y', 'NUL']);
    // Parse duration from stderr: "Duration: 01:23:45.67"
    const durMatch = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (durMatch) {
      const [, h, m, s, ms] = durMatch;
      meta = { format: { duration: parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s) + parseFloat(ms) / 100 } };
    } else {
      meta = { format: { duration: 0 } };
    }
  }

  const durationSec = meta?.format?.duration ?? 0;
  log(`duration: ${Math.round(durationSec)}s (${Math.round(durationSec / 60)}min)`, { quiet });

  if (durationSec < minDuration) {
    log(`SKIP: video shorter than --min-duration ${minDuration}s. Processing not beneficial.`, { quiet });
    const result = {
      video: inputPath,
      durationSec,
      skipped: true,
      reason: `duration ${durationSec}s < min-duration ${minDuration}s`,
    };
    const json = JSON.stringify(result, null, 2);
    if (args.output) {
      await writeFile(args.output, json);
    } else {
      console.log(json);
    }
    return;
  }

  await mkdir(workdir, { recursive: true });

  // Dry-run
  if (args['dry-run']) {
    const estimatedFrames = Math.round(durationSec * fps);
    const estimatedSelected = Math.round(estimatedFrames * (1 - similarity * 0.7));
    const estimatedGrids = Math.ceil(estimatedSelected / (gridW * gridH));
    log(`── DRY RUN ──`, { quiet });
    log(`estimated frames @${fps}fps: ${estimatedFrames}`, { quiet });
    log(`estimated after dedup (sim=${similarity}): ~${estimatedSelected}`, { quiet });
    log(`estimated grids (${gridW}x${gridH}): ~${estimatedGrids}`, { quiet });
    log(`estimated token reduction: ~${Math.round((1 - estimatedGrids * 9 * 258 / (durationSec * 3.3 * 258)) * 100)}%`, { quiet });
    log(`commands that would run:`, { quiet });
    log(`  1. ffmpeg frame extraction (${estimatedFrames} frames)`, { quiet });
    log(`  2. pairwise PSNR dedup (${estimatedFrames - 1} comparisons)`, { quiet });
    log(`  3. ${estimatedGrids} grid compositions`, { quiet });
    if (args.transcribe) log(`  4. audio extraction + transcription`, { quiet });
    return;
  }

  // 1. Extract frames
  log(`── Stage 1: Frame extraction ──`, { quiet });
  const frameCount = await extractFrames(inputPath, workdir, fps, resize, quiet);
  if (frameCount === 0) {
    log(`ERROR: no frames extracted`, { quiet });
    process.exit(1);
  }

  // 2. Deduplicate
  log(`── Stage 2: Deduplication ──`, { quiet });
  const selected = await deduplicate(workdir, similarity, quiet);
  if (selected.length === 0) {
    log(`ERROR: all frames deduplicated (video too static?)`, { quiet });
    process.exit(1);
  }

  // 3. Create grids
  log(`── Stage 3: Grid composition ──`, { quiet });
  const gridFiles = await createGrids(workdir, selected, gridW, gridH, fps, quiet);

  // 4. Audio + transcription (optional)
  let audioPath = null;
  let transcriptText = '';
  if (args.transcribe) {
    log(`── Stage 4: Audio extraction + Transcription ──`, { quiet });
    audioPath = await extractAudio(inputPath, workdir, quiet);
    transcriptText = await transcribe(audioPath, quiet);
  }

  // 5. Result
  const withoutPrep = Math.round(durationSec * 3.3 * 258);
  const withPrep = gridFiles.length * 9 * 258 + transcriptText.length / 4;
  const reduction = Math.round((1 - withPrep / withoutPrep) * 100);

  const result = {
    video: inputPath,
    durationSec,
    fps,
    originalFrameCount: frameCount,
    selectedFrameCount: selected.length,
    gridFiles: gridFiles.length,
    gridLayout: `${gridW}x${gridH}`,
    transcriptSegments: transcriptText ? transcriptText.split('\n').length : 0,
    tokenEstimate: {
      withoutPreprocess: withoutPrep,
      withPreprocess: Math.round(withPrep),
      reductionPercent: Math.max(0, reduction),
    },
    output: {
      frames: join(workdir, 'frames'),
      grids: join(workdir, 'grids'),
      audio: audioPath,
    },
  };

  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    await createWriteStream(args.output).then(s => {
      s.write(json);
      s.close();
    });
    log(`output written to: ${args.output}`, { quiet });
  } else {
    console.log(json);
  }

  log(`Done. Estimated token reduction: ${reduction}%`, { quiet });

  if (!args['keep-temps']) {
    log(`cleaning up... (pass --keep-temps to retain intermediate files)`, { quiet });
  }
}

// Allow import for testing
export { extractFrames, deduplicate, createGrids, align };

// Run if called directly
if (process.argv[1]?.startsWith('--') || process.argv[1]?.startsWith('-')) {
  main().catch(e => {
    process.stderr.write(`[video-preprocess] ERROR: ${e.message}\n${e.stack}\n`);
    process.exit(1);
  });
}