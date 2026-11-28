/**
 * CC モデルポリシー。
 * グロボが起動する claude -p のモデルを検証・記録する。
 * 既定 sonnet、haiku 可。opus は reason 10 文字以上が必要。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 許可するモデル名。opus は制限付き。 */
const ALLOWED = new Set(['sonnet', 'haiku', 'opus']);

/** opus と判定するモデル名のリスト（前方一致）。 */
const OPUS_NAMES = ['opus'];

/**
 * モデルを解決する。
 * @param {{model?:string, reason?:string}} opts
 * @returns {{model:string, reason:string, rejected:boolean}}
 */
export function resolveModel({ model, reason } = {}) {
  const m = String(model ?? '').toLowerCase().trim();
  const r = String(reason ?? '').trim();

  if (!ALLOWED.has(m)) {
    return { model: m || '(empty)', reason: r, rejected: true };
  }

  if (OPUS_NAMES.some((n) => m.startsWith(n))) {
    const rejected = r.length < 10;
    return { model: m, reason: r, rejected };
  }

  return { model: m, reason: r, rejected: false };
}

/**
 * ログファイルへのモデル使用記録を1行追記する。
 * @param {{file?:string, model:string, reason?:string, pc?:string, caseDir?:string, now?:number|string}} opts
 */
export function logModelUsage({
  file,
  model,
  reason = '',
  pc = '',
  caseDir = '',
  now = Date.now(),
} = {}) {
  const ts = typeof now === 'number' ? new Date(now).toISOString() : new Date(now).toISOString();
  const line = JSON.stringify({ ts, pc, model, reason, case: caseDir }) + '\n';
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  }
}