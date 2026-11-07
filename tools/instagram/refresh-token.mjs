import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';
import {
  DEFAULT_ENV_PATH,
  readEnvFile,
  callGraph,
  IgApiError,
} from './ig-api.mjs';

const USAGE = `使い方:
  node tools/instagram/refresh-token.mjs [--env <path>] [--threshold-days 10] [--dry-run] [--json]

オプション:
  --env <path>            環境変数ファイルのパス (既定: ${DEFAULT_ENV_PATH})
  --threshold-days <日>   更新を実行する残り日数しきい値 (既定: 10)
  --dry-run               APIを呼ばず、更新判定のみ表示
  --json                  JSON形式で結果を出力
  --help                  このヘルプを表示`;

export function parseArgs(argv) {
  const options = {
    env: undefined,
    thresholdDays: 10,
    dryRun: false,
    json: false,
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
    } else if (arg === '--env' || arg === '--threshold-days') {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${arg} の値が指定されていません`);
      if (arg === '--env') options.env = val;
      else if (arg === '--threshold-days') {
        options.thresholdDays = parseInt(val, 10);
        if (Number.isNaN(options.thresholdDays) || options.thresholdDays < 0) {
          throw new Error('--threshold-days は0以上の整数を指定してください');
        }
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`不明なオプション: ${arg}`);
    }
  }
  return options;
}

export function readMetaFile(metaPath, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(metaPath)) return null;
    const content = fsImpl.readFileSync(metaPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeMetaFile(metaPath, metaData, fsImpl = fs) {
  const content = `${JSON.stringify(metaData, null, 2)}\n`;
  const dir = path.dirname(metaPath);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${metaPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fsImpl.writeFileSync(tempPath, content, 'utf8');
  fsImpl.renameSync(tempPath, metaPath);
}

export function updateTokenInEnvText(sourceText, newToken) {
  const linePattern = /^(?:export\s+)?INSTAGRAM_ACCESS_TOKEN\s*=.*$/m;
  const replacement = `INSTAGRAM_ACCESS_TOKEN=${newToken}`;
  if (linePattern.test(sourceText)) {
    return sourceText.replace(linePattern, replacement);
  }
  const endsWithNewline = sourceText.endsWith('\n') || sourceText.endsWith('\r');
  const newline = sourceText.includes('\r\n') ? '\r\n' : '\n';
  return `${sourceText}${endsWithNewline ? '' : newline}${replacement}${newline}`;
}

export function atomicUpdateEnvFile(envPath, newToken, fsImpl = fs) {
  let sourceText = '';
  try {
    sourceText = fsImpl.readFileSync(envPath, 'utf8');
  } catch {
    sourceText = '';
  }
  const updated = updateTokenInEnvText(sourceText, newToken);
  const tempPath = `${envPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fsImpl.writeFileSync(tempPath, updated, 'utf8');
  fsImpl.renameSync(tempPath, envPath);
}

export function calculateRemainingDays(expiresAtIso, nowMs = Date.now()) {
  if (!expiresAtIso) return 0;
  const expiresAt = new Date(expiresAtIso).getTime();
  if (Number.isNaN(expiresAt)) return 0;
  return (expiresAt - nowMs) / (24 * 60 * 60 * 1000);
}

export function isWithin24HoursError(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.body || '')}`.toLowerCase();
  return (
    text.includes('24 hour') ||
    text.includes('24 hours') ||
    text.includes('24時間') ||
    text.includes('before 24')
  );
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fsImpl = dependencies.fsImpl ?? fs;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
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

  const envPath = options.env || dependencies.envPath || DEFAULT_ENV_PATH;
  const envVars = readEnvFile(envPath, fsImpl);
  const currentToken = envVars.INSTAGRAM_ACCESS_TOKEN;

  if (!currentToken) {
    stderr.write(`トークン未登録: ${envPath} に INSTAGRAM_ACCESS_TOKEN がありません\n`);
    return 1;
  }

  const metaPath = `${envPath}.meta.json`;
  const meta = readMetaFile(metaPath, fsImpl);

  if (meta && meta.expiresAt) {
    const remainingDays = calculateRemainingDays(meta.expiresAt, nowMs);
    if (remainingDays > options.thresholdDays) {
      const daysFloor = Math.floor(remainingDays);
      if (options.json) {
        stdout.write(
          `${JSON.stringify({ status: 'skipped', remainingDays: daysFloor, expiresAt: meta.expiresAt }, null, 2)}\n`
        );
      } else {
        stdout.write(`更新不要（残${daysFloor}日）\n`);
      }
      return 0;
    }
  }

  const remainingDays = meta?.expiresAt ? calculateRemainingDays(meta.expiresAt, nowMs) : 0;

  if (options.dryRun) {
    const daysFloor = Math.floor(remainingDays);
    if (options.json) {
      stdout.write(
        `${JSON.stringify({ status: 'dry-run', action: 'refresh', remainingDays: daysFloor, thresholdDays: options.thresholdDays }, null, 2)}\n`
      );
    } else {
      stdout.write(`更新対象 (残${daysFloor}日 <= しきい値${options.thresholdDays}日): refresh_access_token を実行予定\n`);
    }
    return 0;
  }

  try {
    const response = await callGraph({
      path: 'https://graph.instagram.com/refresh_access_token',
      method: 'GET',
      params: {
        grant_type: 'ig_refresh_token',
        access_token: currentToken,
      },
      fetchImpl,
    });

    const newToken = response.access_token;
    const expiresIn = response.expires_in; // 秒数
    const expiresAt = new Date(nowMs + expiresIn * 1000).toISOString();
    const remainingAfter = Math.floor(expiresIn / 86400);

    atomicUpdateEnvFile(envPath, newToken, fsImpl);

    const updatedMeta = {
      expiresAt,
      refreshedAt: new Date(nowMs).toISOString(),
      consecutiveFailures: 0,
    };
    writeMetaFile(metaPath, updatedMeta, fsImpl);

    if (options.json) {
      stdout.write(
        `${JSON.stringify({ status: 'refreshed', expiresAt, remainingDays: remainingAfter }, null, 2)}\n`
      );
    } else {
      stdout.write(`更新成功（残${remainingAfter}日）\n`);
    }
    return 0;
  } catch (error) {
    if (isWithin24HoursError(error)) {
      const expiresAt = new Date(nowMs + 60 * 24 * 60 * 60 * 1000).toISOString();
      const assumedMeta = {
        expiresAt,
        refreshedAt: new Date(nowMs).toISOString(),
        consecutiveFailures: 0,
        assumed: true,
      };
      writeMetaFile(metaPath, assumedMeta, fsImpl);

      if (options.json) {
        stdout.write(
          `${JSON.stringify({ status: 'assumed', assumed: true, expiresAt }, null, 2)}\n`
        );
      } else {
        stdout.write('発行から24時間未満のため今回は更新しない。60日と仮定して記録\n');
      }
      return 0;
    }

    const consecutiveFailures = (meta?.consecutiveFailures || 0) + 1;
    const failureMeta = {
      ...(meta || {}),
      consecutiveFailures,
      lastFailureAt: new Date(nowMs).toISOString(),
      lastFailureReason: error.message,
    };
    writeMetaFile(metaPath, failureMeta, fsImpl);

    if (consecutiveFailures >= 3) {
      stderr.write(
        `3回連続で更新に失敗。無人処理を打ち切ります。nishi さんに連絡してください\nNOTIFY: トークン更新が3回連続で失敗しました: ${error.message}\n`
      );
      return 2;
    }

    stderr.write(`トークン更新失敗 (${consecutiveFailures}/3): ${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
