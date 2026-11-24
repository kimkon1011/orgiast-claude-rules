// spool は永続保存され、後から kim-inbox に取り込まれるため配信済みとして扱う。
export function isKimDelivered(result, { extra = [] } = {}) {
  const delivered = result?.delivered;
  return delivered === 'dm' || delivered === 'session-inbox' || delivered === 'spooled' || extra.includes(delivered);
}
