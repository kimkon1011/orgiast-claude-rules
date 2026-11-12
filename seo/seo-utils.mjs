#!/usr/bin/env node
/**
 * seo-utils.mjs — AI SEOエージェント 共通ユーティリティ
 * X-0027: 認証・環境変数・ファイルIO・ログ
 */
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env');

/** .env ファイルを読む（簡易パーサ、export 非対応） */
export function loadEnv(envPath = ENV_PATH) {
  const env = {};
  try {
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      // クォート除去
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        env[key] = val.slice(1, -1);
      } else {
        env[key] = val;
      }
    }
  } catch {
    // .env がなければ空
  }
  return env;
}

/** 環境変数から必須値を取得、なければ fallback */
export function requireEnv(key, fallback = undefined) {
  const env = loadEnv();
  const val = process.env[key] || env[key] || fallback;
  if (!val) throw new Error(`Missing required env: ${key}`);
  return val;
}

/** JSON ファイルを保存（ディレクトリ自動作成） */
export function saveJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/** JSON ファイルを読む */
export function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** 簡易ログ出力（ISO8601 タイムスタンプ付き） */
export function log(level, message, data = undefined) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}`;
  console.log(line);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
  return line;
}

/** 実行時間測定デコレータ */
export function timed(name, fn) {
  const start = Date.now();
  try {
    const result = fn();
    const elapsed = Date.now() - start;
    log('INFO', `${name} completed in ${elapsed}ms`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    log('ERROR', `${name} failed after ${elapsed}ms: ${err.message}`);
    throw err;
  }
}

/** 非同期版 timed */
export async function timedAsync(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    log('INFO', `${name} completed in ${elapsed}ms`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    log('ERROR', `${name} failed after ${elapsed}ms: ${err.message}`);
    throw err;
  }
}

/** 日付文字列 YYYY-MM-DD */
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Google OAuth2 認証スコープ
 * @returns {string[]} GSC + GA4 に必要な scope 一覧
 */
export function gscScopes() {
  return [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
  ];
}

/** 業種スラグからテンプレート名を決定 */
export function industryToSlug(name) {
  return name
    .normalize('NFKC')
    .replace(/[（）()\s]/g, '')
    .replace(/[^\w　-鿿]/g, '-')
    .toLowerCase();
}

export default { loadEnv, requireEnv, saveJSON, loadJSON, log, timed, timedAsync, todayStr, gscScopes, industryToSlug };