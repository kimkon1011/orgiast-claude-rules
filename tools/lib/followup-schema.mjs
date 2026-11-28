// Pure ledger schema and row conversion; no adapters or network.
export const HEADERS = Object.freeze([
  '依頼ID', '依頼先', 'チャネル', 'chatID', '社内外', '依頼内容', '依頼日時',
  '完了条件', '完了パターン', '確認間隔分', '返答期限', '再催促分', '最大催促回数',
  '催促回数', 'エスカレーション先', '担当AI', '担当PC', '状態', '状態理由',
  '最終確認', '最終送信', '最終送信ID', '次回確認', '催促文', '案件', '備考', '更新時刻',
  '担当者区分', '居住地・最寄り', '作業場所',
  '手間チェック記録',
  '依頼種別', '依頼元', '完了の実物種別', '完了の実物', '前提',
  '金さんだけができること', '付け替え先', '成果ソース', '成果許容日数', '最終成果', '最終ジョブ結果',
]);

export const FIELDS = Object.freeze([
  'id', 'to', 'channel', 'chatId', 'scope', 'task', 'requestedAt',
  'doneWhen', 'donePattern', 'intervalMin', 'dueAt', 'renudgeMin', 'maxNudges',
  'nudgeCount', 'escalateTo', 'ownerAi', 'ownerPc', 'status', 'statusReason',
  'lastCheckedAt', 'lastSentAt', 'lastSentId', 'nextCheckAt', 'nudgeText', 'caseName', 'note', 'updatedAt',
  'assigneeRole', 'assigneeLocation', 'taskSite',
  'temaCheck',
  'requestKind', 'requestedBy', 'evidenceKind', 'evidence', 'prereq',
  'kimOnlyAction', 'reassignTo', 'outcomeSource', 'outcomeMaxDays', 'lastOutcomeAt', 'lastJobResult',
]);

export const REQUIRED_FIELDS = Object.freeze(['id', 'to', 'channel', 'task', 'requestedAt', 'doneWhen', 'ownerAi', 'requestKind', 'requestedBy']);
export function normalizeOwnerAi(s) {
  const value = String(s ?? '');
  const key = value.trim().toLowerCase();
  if (['grok', 'grobo', 'グロボ', 'grok bot'].includes(key)) return 'グロボ';
  if (['fuwa', 'ふわ', 'meta muse', 'muse'].includes(key)) return 'ふわ';
  if (['dots', 'dotto', 'どっと'].includes(key)) return 'どっと';
  return value;
}
export function normalizeDate(s) {
  const value = String(s ?? '').trim();
  const match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+09:00` : value;
}
export function normalizeRow(row = {}, { validateRequired = true } = {}) {
  const out = {};
  for (const f of FIELDS) out[f] = row[f] ?? (['intervalMin', 'renudgeMin', 'maxNudges', 'nudgeCount'].includes(f) ? 0 : '');
  for (const [field, fallback] of Object.entries({ intervalMin: 15, renudgeMin: 60, maxNudges: 3 })) {
    out[field] = row[field] == null || String(row[field]).trim() === '' ? fallback : Number(row[field]);
    if (!Number.isFinite(out[field]) || out[field] < 0) out[field] = fallback;
  }
  out.nudgeCount = Number(out.nudgeCount || 0);
  out.channel = String(out.channel || 'manual');
  out.scope = String(out.scope || 'internal');
  out.status = String(out.status || '依頼中');
  out.statusReason = String(out.statusReason || '');
  out.assigneeRole = String(out.assigneeRole || '');
  out.assigneeLocation = String(out.assigneeLocation || '');
  out.taskSite = String(out.taskSite || '');
  out.temaCheck = String(out.temaCheck || '');
  out.requestKind = String(out.requestKind || 'human');
  out.outcomeMaxDays = Number(out.outcomeMaxDays || 0);
  out.ownerAi = normalizeOwnerAi(out.ownerAi);
  for (const field of ['requestedAt', 'dueAt', 'nextCheckAt', 'updatedAt']) out[field] = normalizeDate(out[field]);
  if (validateRequired) {
    const missing = REQUIRED_FIELDS.filter((f) => !String(row[f] ?? '').trim());
    if (missing.length) {
      out.status = '止まった';
      const originalReason = out.statusReason && !out.statusReason.startsWith('必須列不足:') ? `／従来理由: ${out.statusReason}` : '';
      out.statusReason = `必須列不足: ${missing.map((f) => HEADERS[FIELDS.indexOf(f)]).join('・')}${originalReason}`;
    }
  }
  if (row._pendingSheet) out._pendingSheet = true;
  return out;
}

export function rowToValues(row) {
  const n = normalizeRow(row, { validateRequired: false });
  return FIELDS.map((f) => {
    const v = n[f];
    return v == null ? '' : String(v);
  });
}

export function valuesToRow(values = []) {
  const obj = {};
  FIELDS.forEach((f, i) => { obj[f] = values[i] ?? ''; });
  return normalizeRow(obj);
}
