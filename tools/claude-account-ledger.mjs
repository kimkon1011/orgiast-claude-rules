import fs from 'node:fs';

export function loadLedger(file = new URL('./claude-account-ledger.json', import.meta.url)) {
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ledger.version !== 1 || !Array.isArray(ledger.members) || !Array.isArray(ledger.contractedOrgUuids)) {
    throw new Error('アカウント台帳の形式が不正です');
  }
  return ledger;
}

const emails = member => [member.email, ...(member.claudeEmails || [])]
  .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLowerCase());

export function serverProjection(ledger) {
  const retiredEmails = [...new Set(ledger.members.filter(m => m.status === 'retired').flatMap(emails))].sort();
  const retired = new Set(retiredEmails);
  const activeEmails = [...new Set(ledger.members.filter(m => m.status === 'active').flatMap(emails))]
    .filter(email => !retired.has(email)).sort();
  return { contractedOrgUuids: [...new Set(ledger.contractedOrgUuids)].sort(), activeEmails, retiredEmails };
}

export function isContractedLocal(email, ledger) {
  return typeof email === 'string' && serverProjection(ledger).activeEmails.includes(email.trim().toLowerCase());
}

// 同じPCに複数の席がある場合も落とさず返す。退職者も監視対象として残す。
export function membersByPc(ledger) {
  const result = Object.create(null);
  for (const member of ledger.members) {
    for (const pc of member.pcs || []) (result[pc] ||= []).push(member);
  }
  return result;
}
