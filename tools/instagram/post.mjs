import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';
import {
  DEFAULT_ENV_PATH,
  readEnvFile,
  resolveUserId,
  postToInstagram,
  IgApiError,
} from './ig-api.mjs';

const USAGE = `使い方:
  node tools/instagram/post.mjs --image <公開HTTPS URL> [--caption <text>|--caption-file <path>]
  node tools/instagram/post.mjs --video <公開HTTPS URL> --type REELS [--caption ...]

オプション:
  --image <url>         投稿する画像の公開HTTPS URL (JPEG推奨)
  --video <url>         投稿する動画の公開HTTPS URL (MP4)
  --caption <text>      投稿のキャプション文字列
  --caption-file <path> キャプションが書かれたテキストファイルへのパス
  --type <TYPE>         メディア種別 (IMAGE | REELS | STORIES)
  --env <path>          環境変数ファイルのパス (既定: ${DEFAULT_ENV_PATH})
  --max-per-day <n>     24時間あたりの最大投稿数 (既定: 10)
  --dry-run             APIを呼ばず、パラメータのみ確認して終了
  --json                JSON形式で結果を出力
  --timeout <秒>        タイムアウト秒数 (既定: 300)
  --help                このヘルプを表示`;

export function parseArgs(argv) {
  const options = {
    image: undefined,
    video: undefined,
    caption: undefined,
    captionFile: undefined,
    type: undefined,
    env: undefined,
    maxPerDay: 10,
    dryRun: false,
    json: false,
    timeout: 300,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (
      [
        '--image',
        '--video',
        '--caption',
        '--caption-file',
        '--type',
        '--env',
        '--max-per-day',
        '--timeout',
      ].includes(arg)
    ) {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${arg} の値が指定されていません`);
      if (arg === '--image') options.image = val;
      else if (arg === '--video') options.video = val;
      else if (arg === '--caption') options.caption = val;
      else if (arg === '--caption-file') options.captionFile = val;
      else if (arg === '--type') options.type = val.toUpperCase();
      else if (arg === '--env') options.env = val;
      else if (arg === '--max-per-day') {
        options.maxPerDay = parseInt(val, 10);
        if (Number.isNaN(options.maxPerDay) || options.maxPerDay < 1) {
          throw new Error('--max-per-day は1以上の整数を指定してください');
        }
      } else if (arg === '--timeout') {
        options.timeout = parseInt(val, 10);
        if (Number.isNaN(options.timeout) || options.timeout < 1) {
          throw new Error('--timeout は1以上の秒数を指定してください');
        }
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`不明なオプション: ${arg}`);
    }
  }
  return options;
}

export function readDailyPostCount(logPath, fsImpl = fs, nowMs = Date.now()) {
  try {
    if (!fsImpl.existsSync(logPath)) return 0;
    const content = fsImpl.readFileSync(logPath, 'utf8');
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed);
        if (item.at && new Date(item.at).getTime() >= cutoff) {
          count += 1;
        }
      } catch {}
    }
    return count;
  } catch {
    return 0;
  }
}

export function appendPostLog(logPath, entry, fsImpl = fs) {
  const line = `${JSON.stringify(entry)}\n`;
  const dir = path.dirname(logPath);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  fsImpl.appendFileSync(logPath, line, 'utf8');
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fsImpl = dependencies.fsImpl ?? fs;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep;
  const nowMs = dependencies.nowMs ?? Date.now();

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 1;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (!options.image && !options.video) {
    stderr.write(`エラー: --image または --video のどちらか一方を指定してください\n${USAGE}\n`);
    return 1;
  }

  if (options.image && options.video) {
    stderr.write('エラー: --image と --video を同時に指定することはできません\n');
    return 1;
  }

  const url = options.image || options.video;
  if (!url.startsWith('https://')) {
    stderr.write(`エラー: メディアURLは https:// で始まる公開URLである必要があります: ${url}\n`);
    return 2;
  }

  let mediaType = options.type;
  if (!mediaType) {
    mediaType = options.image ? 'IMAGE' : 'REELS';
  }

  if (!['IMAGE', 'REELS', 'STORIES'].includes(mediaType)) {
    stderr.write(`エラー: 不正なメディア種別です: ${mediaType} (IMAGE | REELS | STORIES)\n`);
    return 1;
  }

  let caption = '';
  if (options.captionFile) {
    try {
      caption = fsImpl.readFileSync(options.captionFile, 'utf8');
    } catch (error) {
      stderr.write(`エラー: キャプションファイルを読み込めません (${options.captionFile}): ${error.message}\n`);
      return 1;
    }
  } else if (options.caption) {
    caption = options.caption;
  }

  if (!caption.trim()) {
    stderr.write('警告: キャプションが空です\n');
  }

  const envPath = options.env || dependencies.envPath || DEFAULT_ENV_PATH;
  const envVars = readEnvFile(envPath, fsImpl);

  if (options.dryRun) {
    const urlKey = options.image ? 'image_url' : 'video_url';
    const dryRunPayload = {
      ig_user_id: envVars.INSTAGRAM_USER_ID || 'dummy_user_id',
      media_type: mediaType,
      [urlKey]: url,
      caption_length: caption.length,
    };
    stdout.write(`${JSON.stringify(dryRunPayload, null, 2)}\n`);
    return 0;
  }

  const accessToken = envVars.INSTAGRAM_ACCESS_TOKEN;
  if (!accessToken) {
    stderr.write(`エラー: INSTAGRAM_ACCESS_TOKEN が未設定です (${envPath})\n`);
    return 1;
  }

  const envDir = path.dirname(envPath);
  const logPath = path.join(envDir, 'post-log.jsonl');
  const dailyCount = readDailyPostCount(logPath, fsImpl, nowMs);
  if (dailyCount >= options.maxPerDay) {
    stderr.write(
      `エラー: 過去24時間の投稿数が上限 (${options.maxPerDay}件) に達しています (現在: ${dailyCount}件)。投稿を中止します。\n`
    );
    return 3;
  }

  // --timeout（秒）を実際の HTTP 呼び出しに適用する。
  // 以前は引数を解析するだけで送信時のタイムアウトに一切反映されておらず、動画のコンテナ待ちで
  // 無期限にぶら下がる恐れがあった（2026-10-15 修正）。
  const timeoutMs = options.timeout * 1000;
  const timeoutFetch = (input, init = {}) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  try {
    let igUserId = envVars.INSTAGRAM_USER_ID;
    if (!igUserId) {
      const resolved = await resolveUserId({ accessToken, fetchImpl: timeoutFetch });
      igUserId = resolved.userId;
    }

    const result = await postToInstagram({
      igUserId,
      mediaType,
      url,
      caption,
      accessToken,
      fetchImpl: timeoutFetch,
      sleep,
    });

    appendPostLog(
      logPath,
      {
        at: new Date(nowMs).toISOString(),
        mediaId: result.mediaId,
        permalink: result.permalink,
        mediaType,
      },
      fsImpl
    );

    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`media id: ${result.mediaId}\npermalink: ${result.permalink}\n`);
    }
    return 0;
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      stderr.write(`投稿エラー: ${options.timeout}秒のタイムアウトを超えました\n`);
    } else if (error instanceof IgApiError) {
      stderr.write(
        `Meta API エラー (code: ${error.code ?? 'none'}, subcode: ${error.subcode ?? 'none'}): ${error.message}\n`
      );
    } else {
      stderr.write(`投稿エラー: ${error.message}\n`);
    }
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
