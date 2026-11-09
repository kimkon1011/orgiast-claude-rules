import fs from 'node:fs';
import path from 'node:path';

// Read only explicitly linked artifacts or the DONE sibling of a checked job log.
export function checkLogPaths(row) {
  return [...String(row.check || row.startWhen || '').matchAll(/['"]([^'"\r\n]+\.log)['"]/g)].map(m => m[1]);
}
export function artifactCandidates(row, home) {
  const files = [row.doneFile, row.artifact, row.doneNotifyArtifact].filter(v => typeof v === 'string' && /\.md$/i.test(v));
  for (const log of checkLogPaths(row)) {
    const name = log.replace(/\\/g, '/').split('/').pop().replace(/^scheduled-/, '').replace(/-\d{4}-\d{2}-\d{2}\.log$/, '');
    if (!name.endsWith('.log')) files.push(path.join(home, '.claude', 'logs', `${name}-DONE.md`));
  }
  return [...new Set(files.map(file => path.isAbsolute(file) || /^[a-z]:[\\/]/i.test(file) ? file : path.resolve(row.checkCwd || row.cwd || '.', file)))];
}
export function extractKimActions(text) {
  const actions = []; let inside = false, depth = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    if (heading) {
      if (inside && heading[1].length <= depth) inside = false;
      if (/kim.*(?:承認待ち|すること|判断待ち)|承認待ち事項/i.test(heading[2])) { inside = true; depth = heading[1].length; }
      continue;
    }
    if (!inside) continue;
    const item = /^\s*(?:\d+[.)]|[-*]\s+(?:\[ \]\s*)?)\s*(.+)/.exec(line);
    if (item) {
      const title = /^\*\*(.+?)\*\*/.exec(item[1]);
      actions.push((title ? title[1] : item[1]).replace(/\*\*/g, '').slice(0, 220));
    }
  }
  return actions;
}
export function completionActions(row, { home, readFile = fs.readFileSync } = {}) {
  const candidates = artifactCandidates(row, home); const errors = []; let readable;
  for (const file of candidates) {
    try {
      const actions = extractKimActions(readFile(file, 'utf8'));
      if (actions.length) return { kind: 'ask', file, actions, text: `成果物: ${file}\nkim の承認待ち ${actions.length} 件:\n${actions.map((s, i) => `${i + 1}. ${s}`).join('\n')}` };
      readable = file;
    } catch (error) { errors.push(`${file}: ${error.code || error.message}`); }
  }
  const next = String(row.nextKim || '').trim();
  if (next && !/^(?:特に)?(?:なし|無し|ナシ)/.test(next)) return { kind: 'ask', actions: [next], text: `kim がすること: ${next}` };
  if (readable) return { kind: 'info', file: readable, actions: [], text: `成果物: ${readable}\nkim がすること: 成果物に承認待ちの列挙なし` };
  return { kind: 'info', actions: [], text: errors.length ? `成果物の確認未了: ${errors.join(' / ')}\nkim の承認待ち: 未確認` : 'kim がすること: なし（台帳上。成果物の指定なし）' };
}
