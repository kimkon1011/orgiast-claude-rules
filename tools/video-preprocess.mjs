#!/usr/bin/env node
/**
 * X-0002: Video Preprocessor — Node.js wrapper
 *
 * Orchestrates the Python video-frame-preprocessor.py pipeline and
 * provides Gemini CLI integration for token-efficient video analysis.
 *
 * Usage:
 *   node tools/video-preprocess.mjs input.mp4
 *   node tools/video-preprocess.mjs input.mp4 --interval 30 --threshold 3
 *   node tools/video-preprocess.mjs input.mp4 --transcript captions.srt
 *   node tools/video-preprocess.mjs input.mp4 --gemini "この動画の内容を要約してください"
 *   node tools/video-preprocess.mjs input.mp4 --gemini --json
 *   node tools/video-preprocess.mjs --help
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.join(__dirname, 'video-frame-preprocessor.py');

function getPythonCmd() {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return 'python3';
  } catch {
    return 'python';
  }
}

function parseArgs(argv) {
  const opts = {
    interval: 10,
    threshold: 5,
    gridCols: 3,
    gridRows: 3,
    transcript: null,
    noDedup: false,
    quality: 5,
    thumbnailWidth: 640,
    fontSize: 20,
    outputDir: null,
    gemini: false,
    geminiPrompt: null,
    json: false,
    help: false,
    video: null,
  };

  const promptParts = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        opts.help = true;
        i++;
        break;
      case '--interval':
      case '-i':
        opts.interval = parseInt(argv[++i], 10);
        i++;
        break;
      case '--threshold':
      case '-t':
        opts.threshold = parseInt(argv[++i], 10);
        i++;
        break;
      case '--grid-cols':
        opts.gridCols = parseInt(argv[++i], 10);
        i++;
        break;
      case '--grid-rows':
        opts.gridRows = parseInt(argv[++i], 10);
        i++;
        break;
      case '--transcript':
      case '-s':
        opts.transcript = argv[++i];
        i++;
        break;
      case '--no-dedup':
        opts.noDedup = true;
        i++;
        break;
      case '--quality':
        opts.quality = parseInt(argv[++i], 10);
        i++;
        break;
      case '--thumbnail-width':
        opts.thumbnailWidth = parseInt(argv[++i], 10);
        i++;
        break;
      case '--font-size':
        opts.fontSize = parseInt(argv[++i], 10);
        i++;
        break;
      case '--output-dir':
      case '-o':
        opts.outputDir = argv[++i];
        i++;
        break;
      case '--gemini':
        opts.gemini = true;
        i++;
        break;
      case '--json':
        opts.json = true;
        i++;
        break;
      default:
        if (!arg.startsWith('--')) {
          if (!opts.video) {
            opts.video = arg;
          } else {
            promptParts.push(arg);
          }
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
        i++;
        break;
    }
  }

  if (promptParts.length > 0) {
    opts.geminiPrompt = promptParts.join(' ');
  }

  return opts;
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const python = getPythonCmd();
    const procArgs = [PYTHON_SCRIPT, args.video];
    if (args.interval !== 10) procArgs.push('--interval', String(args.interval));
    if (args.threshold !== 5) procArgs.push('--threshold', String(args.threshold));
    if (args.gridCols !== 3) procArgs.push('--grid-cols', String(args.gridCols));
    if (args.gridRows !== 3) procArgs.push('--grid-rows', String(args.gridRows));
    if (args.transcript) procArgs.push('--transcript', args.transcript);
    if (args.noDedup) procArgs.push('--no-dedup');
    if (args.quality !== 5) procArgs.push('--quality', String(args.quality));
    if (args.thumbnailWidth !== 640) procArgs.push('--thumbnail-width', String(args.thumbnailWidth));
    if (args.fontSize !== 20) procArgs.push('--font-size', String(args.fontSize));
    if (args.outputDir) procArgs.push('--output-dir', args.outputDir);

    const child = spawn(python, procArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(new Error(`Python script exited code ${code}: ${stderr}`));
        return;
      }

      // Parse SUMMARY block from stdout
      const summaryMatch = stdout.match(/---SUMMARY---\n([\s\S]*?)\n---ENDSUMMARY---/);
      let summary = null;
      if (summaryMatch) {
        try {
          summary = JSON.parse(summaryMatch[1]);
        } catch {
          // summary parse error — non-fatal
        }
      }

      resolve({ stdout, stderr, summary });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

async function runGemini(summary, prompt) {
  /**
   * Send preprocessed grids to Gemini CLI for analysis.
   */
  const geminiPrompt = prompt || 'この動画の内容を詳しく説明してください。各グリッド画像にはタイムスタンプが付いています。';
  const gridDir = summary.output_dir;

  // Build Gemini CLI args with all grid images
  const geminiArgs = ['gemini', '--prompt', geminiPrompt];
  for (const gf of summary.grid_files) {
    geminiArgs.push('--image', path.join(gridDir, gf));
  }
  geminiArgs.push('--metadata', path.join(gridDir, summary.metadata_file));

  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'cmd' : 'sh', [
      process.platform === 'win32' ? '/c' : '-c',
      `npx @google/gemini-cli ${geminiArgs.slice(1).map(a => `"${a}"`).join(' ')}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
        success: code === 0,
      });
    });
    child.on('error', (err) => reject(err));
  });
}

function showHelp() {
  console.log(`
X-0002: Video Preprocessor for Gemini Token Reduction

Usage:
  node tools/video-preprocess.mjs <video> [options]

Options:
  --interval, -i <sec>    Frame extraction interval (default: 10)
  --threshold, -t <num>   dHash dedup threshold 0-64 (default: 5, lower=stricter)
  --grid-cols <num>       Grid columns (default: 3)
  --grid-rows <num>       Grid rows (default: 3)
  --transcript, -s <file> Transcript/subtitle file (SRT/VTT)
  --no-dedup              Skip frame deduplication
  --quality <1-31>        JPEG quality (lower=better, default: 5)
  --thumbnail-width <px>  Thumbnail width (default: 640)
  --font-size <pt>        Timestamp font size (default: 20)
  --output-dir, -o <dir>  Output directory (default: ./gemini-grids)
  --gemini                Send results to Gemini CLI after preprocessing
  --json                  Output JSON summary
  --help                  Show this help

Examples:
  node tools/video-preprocess.mjs event.mp4
  node tools/video-preprocess.mjs event.mp4 --interval 30 --threshold 3
  node tools/video-preprocess.mjs event.mp4 --transcript captions.srt --gemini
  node tools/video-preprocess.mjs event.mp4 --json

Token savings (1h video, interval=10s):
  Raw frames: ~360 × 2587 tokens ≈ 931K tokens
  After dedup+grid: ~40-80 × 2587 ≈ 103-207K tokens
  Reduction: ~78-89%
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.video) {
    showHelp();
    process.exit(args.help ? 0 : 1);
  }

  if (!fs.existsSync(args.video)) {
    console.error(`Error: Video file not found: ${args.video}`);
    process.exit(1);
  }

  console.error(`🎬 Video Preprocessor (X-0002)`);
  console.error(`   Input: ${args.video}`);

  try {
    const result = await runPython(args);

    if (result.summary && args.json) {
      console.log(JSON.stringify(result.summary, null, 2));
    } else if (!args.gemini) {
      // stdout from Python already printed
      process.stdout.write(result.stdout);
    }

    if (args.gemini && result.summary) {
      console.error(`\n🤖 Sending ${result.summary.grids} grids to Gemini CLI...`);
      const geminiResult = await runGemini(result.summary, args.geminiPrompt);
      if (geminiResult.success) {
        console.log(geminiResult.stdout);
      } else {
        console.error(`Gemini CLI exit code: ${geminiResult.exitCode}`);
        console.error(geminiResult.stderr);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
