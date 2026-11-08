import fs from 'node:fs/promises';
import path from 'node:path';
import { normalize, writePrivate, reason, auditError } from './common.mjs';
import { webSearch, askJson, safeUrl } from './leak-search.mjs';
export const PATTERN_QUERIES = ['横領 手口 2026 事例', '架空取引 経理 不正 発覚 2026', '内部不正 情報持ち出し 事例 2026', 'ACFE Report to the Nations 2026 occupational fraud', 'ビジネスメール詐欺 振込先変更 2026'];
export async function refreshPatterns({ stateDir, patterns, search = webSearch, ask = askJson, now = new Date() }) {
  const file = path.join(stateDir, 'pattern-candidates.jsonl'); let existing = [];
  try { existing = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  catch (e) { if (e.code !== 'ENOENT') throw auditError('パターン候補ファイルが不正（上書きしません）'); }
  const seen = new Set(existing.map(p => normalize(p.name))), candidates = [], sources = {};
  for (const [i, query] of PATTERN_QUERIES.entries()) try {
    const rows = await search(query), allowed = new Set(rows.map(r => r.url));
    if (!rows.length) throw auditError('検索の引用URLがありません');
    const result = await ask(`公開資料から不正の検出候補を抽出。既存ルールを変更せず、JSON配列 [{"id":"候補ID","name":"手口名","category":"分類","signal":"兆候","data_source":"必要なデータ","rule_sketch":"判定案","source_url":"入力にあるURL"}] のみ。source_url は入力にあるものをそのまま使う。引用データ: ${JSON.stringify(rows)}`);
    if (!Array.isArray(result)) throw auditError('LLM抽出形式不正');
    for (const p of result) {
      if (!['id','name','category','signal','data_source','rule_sketch','source_url'].every(k => typeof p[k] === 'string' && p[k].trim()) || !allowed.has(safeUrl(p.source_url))) continue;
      const key = normalize(p.name); if (seen.has(key)) continue; seen.add(key);
      const implemented = patterns.patterns.find(r => normalize(r.name) === key && r.status === 'rule');
      candidates.push(Object.fromEntries([...['id','name','category','signal','data_source','rule_sketch','source_url'].map(k => [k, p[k].slice(0, 2000)]), ['createdAt', now.toISOString()], ['rules', implemented?.rules || []]]));
    }
    sources[`patterns:${i + 1}`] = { status: 'ok', count: result.length, reason: '候補のみ。自動でルール・しきい値を変更しません' };
  } catch (e) { sources[`patterns:${i + 1}`] = { status: 'failed', count: 0, reason: reason(e) }; }
  if (candidates.length) await writePrivate(file, [...existing, ...candidates].map(p => JSON.stringify(p)).join('\n') + '\n');
  return { candidates, sources };
}
