import { maskNumbers } from './common.mjs';

export function shareDomain(permission) {
  return permission.type === 'anyone' ? 'anyone' : (permission.domain || permission.emailAddress?.split('@').at(-1) || '不明').toLowerCase();
}
export function summarizeShares(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.owner || '所有者不明（旧snapshot）', entry.type === 'anyone' ? 'anyone' : '外部ドメイン', entry.domain]);
    groups.set(key, (groups.get(key) || 0) + (entry.count || 1));
  }
  return [...groups].map(([key, count]) => {
    const [owner, type, domain] = JSON.parse(key);
    return { owner, type, domain, count };
  }).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
export function baselineFinding(summary, building = true) {
  return { rule: 'exfil', severity: 'info', subject: building ? '外部共有ベースライン構築中' : '外部共有の現状',
    detail: `${summary.reduce((sum, row) => sum + row.count, 0)}権限。ユーザー・共有種別・ドメイン別集計は「外部共有の現状（ベースライン）」参照` };
}
export function replaySharing(snapshot) {
  if (snapshot.externalSharing) return { findings: snapshot.exfilFindings || [], baseline: snapshot.externalSharing };
  const retained = [], entries = [];
  for (const f of snapshot.exfilFindings || []) {
    if (f.rule !== 'exfil') { retained.push(f); continue; }
    const recipient = f.detail.match(/共有（初回は既存共有を含む）: (.*?) \/ /)?.[1];
    if (!recipient) continue;
    const anyone = recipient === 'リンクを知っている全員';
    entries.push({ owner: f.owner, type: anyone ? 'anyone' : 'external', domain: anyone ? 'anyone' : recipient.split('@').at(-1).toLowerCase() });
  }
  const summary = summarizeShares(entries);
  if (summary.length) retained.push(baselineFinding(summary));
  return { findings: retained, baseline: { building: true, summary,
    limitation: '旧snapshotの部分取得分。所有ユーザーと再開位置は保存されていないため未確認。再評価ではベースラインを確定しません。' } };
}
export function sharingFinding(file, permission) {
  return { rule: 'exfil', severity: permission.type === 'anyone' ? 'medium' : 'high', subject: maskNumbers(file.name), owner: file.owner,
    url: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
    detail: `新規検出の外部共有: ${permission.type === 'anyone' ? 'リンクを知っている全員' : permission.emailAddress || permission.domain} / ${permission.role}` };
}
