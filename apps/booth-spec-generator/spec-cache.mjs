// ブース仕様JSONの圧縮、復元、保存、読み込み、GCを扱う。

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const REQUIRED_ARRAY_PATHS = new Set(['booth.open_sides', 'booth.walls', 'items', 'views']);

function roundNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalize(value, path = '') {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return roundNumber(value);
  if (Array.isArray(value)) {
    const result = value
      .map((entry, index) => normalize(entry, `${path}[${index}]`))
      .filter(entry => entry !== undefined);
    return result.length > 0 || REQUIRED_ARRAY_PATHS.has(path) ? result : undefined;
  }
  if (typeof value !== 'object') return value;

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const normalized = normalize(entry, childPath);
    if (normalized !== undefined) result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function itemKey(item) {
  const identity = item.asset_id ?? item.param ?? '';
  const position = Array.isArray(item.pos_mm) ? item.pos_mm.map(roundNumber) : [];
  return JSON.stringify([identity, position]);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeFileName(caseId) {
  const name = `${caseId}.json`;
  if (!caseId || basename(name) !== name || /[<>:"/\\|?*\x00-\x1f]/u.test(name)) {
    throw new Error(`保存できない case_id です: ${caseId ?? ''}`);
  }
  return name;
}

function readIndex(cacheDir) {
  const indexPath = join(cacheDir, 'index.json');
  if (!existsSync(indexPath)) return { specs: [] };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    return { specs: Array.isArray(parsed.specs) ? parsed.specs : [] };
  } catch {
    return { specs: [] };
  }
}

function writeIndex(cacheDir, index) {
  writeFileSync(join(cacheDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/**
 * 仕様を圧縮する。丸め、空値除去、同一アセット・座標の重複除去を行い、
 * 10文字を超えて短くなる場合だけ座標をブース中心からの相対値にする。
 */
export function compress(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const result = normalize(spec);
  if (!result) return null;

  if (Array.isArray(result.items)) {
    const seen = new Set();
    result.items = result.items.filter(item => {
      const key = itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const width = result.booth?.w_mm;
  const depth = result.booth?.d_mm;
  if (typeof width !== 'number' || typeof depth !== 'number' || !Array.isArray(result.items)) return result;

  const center = [roundNumber(width / 2), roundNumber(depth / 2), 0];
  const positions = result.items.filter(item => Array.isArray(item.pos_mm) && item.pos_mm.length === 3);
  const absoluteLength = positions.reduce((sum, item) => sum + JSON.stringify(item.pos_mm).length, 0);
  const relative = positions.map(item => item.pos_mm.map((value, index) => roundNumber(value - center[index])));
  const relativeLength = relative.reduce((sum, position) => sum + JSON.stringify(position).length, 0)
    + JSON.stringify(center).length + 24;

  if (absoluteLength - relativeLength > 10) {
    positions.forEach((item, index) => { item.pos_mm = relative[index]; });
    result._compressed = { relative_center: center };
  }
  return result;
}

/** 圧縮仕様を通常のブース仕様へ復元する。 */
export function decompress(compressed) {
  if (!compressed || typeof compressed !== 'object' || Array.isArray(compressed)) return null;
  const result = structuredClone(compressed);
  const center = result._compressed?.relative_center;
  delete result._compressed;

  if (Array.isArray(center) && center.length === 3 && Array.isArray(result.items)) {
    for (const item of result.items) {
      if (Array.isArray(item.pos_mm) && item.pos_mm.length === 3) {
        item.pos_mm = item.pos_mm.map((value, index) => roundNumber(value + center[index]));
      }
    }
  }
  return result;
}

/** 仕様をキャッシュへ保存し、保存先を返す。 */
export function save(cacheDir, spec) {
  if (!cacheDir || typeof cacheDir !== 'string') throw new TypeError('cacheDir が必要です');
  if (!spec || typeof spec !== 'object') throw new TypeError('spec が必要です');
  const file = safeFileName(spec.case_id);
  const compressed = compress(spec);
  if (!compressed) throw new Error('仕様を圧縮できませんでした');

  const specsDir = join(cacheDir, 'specs');
  mkdirSync(specsDir, { recursive: true });
  const filePath = join(specsDir, file);
  const serialized = `${JSON.stringify(compressed)}\n`;
  writeFileSync(filePath, serialized, 'utf8');

  const index = readIndex(cacheDir);
  index.specs = index.specs.filter(entry => entry.case_id !== spec.case_id);
  index.specs.push({
    case_id: spec.case_id,
    title: spec.title ?? '',
    file,
    createdAt: new Date().toISOString(),
    size: byteLength(spec),
    compressedSize: Buffer.byteLength(serialized, 'utf8')
  });
  writeIndex(cacheDir, index);
  return filePath;
}

/** case_id に一致する仕様を読み込む。見つからない場合は null を返す。 */
export function load(cacheDir, caseId) {
  const entry = readIndex(cacheDir).specs.find(candidate => candidate.case_id === caseId);
  if (!entry || basename(entry.file) !== entry.file) return null;
  const filePath = join(cacheDir, 'specs', entry.file);
  if (!existsSync(filePath)) return null;
  try {
    return decompress(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

/** キャッシュ索引の公開項目を、作成日時の新しい順で返す。 */
export function list(cacheDir) {
  return readIndex(cacheDir).specs
    .map(({ case_id, title, createdAt, size, compressedSize }) => ({ case_id, title, createdAt, size, compressedSize }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** 期限切れ、またはグループの保持世代数を超えたキャッシュを削除する。 */
export function gc(cacheDir, maxAgeDays = 30, maxGenerations = 5) {
  const indexPath = join(cacheDir, 'index.json');
  if (!existsSync(indexPath)) return { deleted: 0, kept: 0, savedBytes: 0 };
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new RangeError('maxAgeDays は0以上にしてください');
  if (!Number.isInteger(maxGenerations) || maxGenerations < 0) throw new RangeError('maxGenerations は0以上の整数にしてください');

  const index = readIndex(cacheDir);
  const groups = new Map();
  for (const entry of index.specs) {
    const group = String(entry.case_id).replace(/-v\d+$/iu, '');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }

  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const kept = [];
  const deleted = [];
  for (const entries of groups.values()) {
    const fresh = entries
      .filter(entry => Number.isFinite(Date.parse(entry.createdAt)) && Date.parse(entry.createdAt) > cutoff)
      .sort((a, b) => {
        const versionA = Number(String(a.case_id).match(/-v(\d+)$/iu)?.[1] ?? -1);
        const versionB = Number(String(b.case_id).match(/-v(\d+)$/iu)?.[1] ?? -1);
        return versionB - versionA || Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
    const survivors = new Set(fresh.slice(0, maxGenerations));
    for (const entry of entries) (survivors.has(entry) ? kept : deleted).push(entry);
  }

  let savedBytes = 0;
  for (const entry of deleted) {
    if (basename(entry.file) !== entry.file) continue;
    const filePath = join(cacheDir, 'specs', entry.file);
    if (!existsSync(filePath)) continue;
    try {
      savedBytes += statSync(filePath).size;
      unlinkSync(filePath);
    } catch {
      // 他プロセスによる削除などは索引更新を妨げない。
    }
  }

  writeIndex(cacheDir, { specs: kept });
  return { deleted: deleted.length, kept: kept.length, savedBytes };
}
