import { cell } from './common.mjs';
const money = n => Number(n || 0).toLocaleString('en-US') + '円';
export function renderPayees(lines, snapshot, file) {
  lines.push('', '## 汎用取引先の実名解決', '', '日付・同額による候補照合です。「候補複数」は実名確定前。a=振込シート、b=口座明細、c=購買DB、d=購買依頼フォーム。', '',
    '| 汎用名 | 件数 | 合計 | 解決率 | a / b / c / d | 未解決件数 | 未解決合計 |', '|---|---:|---:|---:|---|---:|---:|');
  const r = snapshot.payeeResolution;
  if (!r) { lines.push('| — | — | — | 未実施（旧snapshot） | — | — | — |'); return; }
  for (const s of r.summary) lines.push(`| ${cell(s.name)} | ${s.count} | ${money(s.amount)} | ${(100 * s.resolvedCount / s.count).toFixed(1)}% | ${['a','b','c','d'].map(k => s.methods[k]).join(' / ')} | ${s.unresolvedCount} | ${money(s.unresolvedAmount)} |`);
  lines.push('', '| 実名（候補） | 区分 | 検索語（実際に使用） | 件数 | 合計 | 形跡の結果 | resolved_by |', '|---|---|---|---:|---:|---|---|');
  const visible = r.payees.length > 200 ? r.payees.slice(0, 199) : r.payees;
  for (const p of visible) {
    const fp = snapshot.footprint?.[p.id];
    const result = p.internal ? '社内の人への支払いのため形跡照合対象外' : ['gmail','drive','discord'].map(k => `${k}: ${fp?.[k]?.count ?? '未照合'} / ${fp?.[k]?.status || 'unverified'}`).join('; ');
    const queries = p.internal ? '対象外' : ['gmail','drive','discord'].map(k => `${k}: ${fp?.[k]?.queriedTerms?.join(' / ') || '未照合（検索語の記録なし）'}`).join('; ');
    lines.push(`| ${cell(p.name)}${p.ambiguous ? '（候補複数）' : ''} | ${cell(p.classification || p.classifications.join(' / '))} | ${cell(queries)} | ${p.count} | ${money(p.amount)} | ${cell(result)} | ${p.resolved_by.join(', ')} |`);
  }
  if (visible.length < r.payees.length) lines.push(`| 他 ${r.payees.length - visible.length}行 | ${cell(file)} 参照 | — | — | — | — | — |`);
}
export function renderR10(lines, findings, file, minSeverity = 'info') {
  const levels = ['high','medium','info'];
  const rows = findings.filter(f => f.rule === 'R10' && levels.indexOf(f.severity) <= levels.indexOf(minSeverity)), groups = new Map();
  lines.push('', '## R10 明細あり・取引未登録（freee 消込待ち）', '', '明細は同期済みですが、仕訳の登録・消込が未処理です。無視された出金は別の状態として表示します。', '', '| 口座 | 状態 | 件数 | 合計 |', '|---|---|---:|---:|');
  for (const f of rows) {
    const k = JSON.stringify([f.walletableType, f.walletableId, f.subject]);
    const g = groups.get(k) || { name: f.subject, statuses: new Set(), count: 0, amount: 0 };
    g.statuses.add(f.walletStatus === 3 ? '無視された出金' : '明細あり・取引未登録');
    g.count++; g.amount += f.amount || 0; groups.set(k, g);
  }
  for (const g of groups.values()) lines.push(`| ${cell(g.name)} | ${[...g.statuses].join(' / ')} | ${g.count} | ${money(g.amount)} |`);
  lines.push('', '金額上位10件（全個別行: ' + cell(file) + '）', '', '| 重要度 | 口座 | 詳細 |', '|---|---|---|');
  for (const f of [...rows].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 10)) lines.push(`| ${f.severity} | ${cell(f.subject)} | ${cell(f.detail)} |`);
}
