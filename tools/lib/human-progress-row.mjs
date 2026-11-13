// Explicit human ledger provenance; an automatic check does not change its owner.
export const isKimHumanProgress = row => ['kim', 'kim@orgiast.jp'].includes(String(row?.owner || '').trim().toLowerCase())
  && Boolean(String(row?.transcriptPath || '').trim()) && Boolean(String(row?.label || row?.promise || '').trim());
