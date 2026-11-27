// Pure ledger schema and row conversion; no adapters or network.
export const HEADERS = Object.freeze([
  '依頼ID', '依頼先', 'チャネル', 'chatID', '社内外', '依頼内容', '依頼日時',
  '完了条件', '完了パターン', '確認間隔分', '返答期限', '再催促分', '最大催促回数',
  '催促回数', 'エスカレーション先', '担当AI', '担当PC', '状態', '状態理由',
  '最終確認', '最終送信', '最終送信ID', '次回確認', '催促文', '案件', '備考', '更新時刻',
  '担当者区分', '居住地・最寄り', '作業場所',
  '手間チェック記録',
]);

export const FIELDS = Object.freeze([
  'id', 'to', 'channel', 'chatId', 'scope', 'task', 'requestedAt',
  'doneWhen', 'donePattern', 'intervalMin', 'dueAt', 'renudgeMin', 'maxNudges',
  'nudgeCount', 'escalateTo', 'ownerAi', 'ownerPc', 'status', 'statusReason',
  'lastCheckedAt', 'lastSentAt', 'lastSentId', 'nextCheckAt', 'nudgeText', 'caseName', 'note', 'updatedAt',
  'assigneeRole', 'assigneeLocation', 'taskSite',
  'temaCheck',
]);

export function normalizeRow(row = {}) {
  const out = {};
  for (const f of FIELDS) out[f] = row[f] ?? (['intervalMin', 'renudgeMin', 'maxNudges', 'nudgeCount'].includes(f) ? 0 : '');
  out.intervalMin = Number(out.intervalMin || 0);
  out.renudgeMin = Number(out.renudgeMin || 0);
  out.maxNudges = Number(out.maxNudges || 0);
  out.nudgeCount = Number(out.nudgeCount || 0);
  out.channel = String(out.channel || 'manual');
  out.scope = String(out.scope || 'internal');
  out.status = String(out.status || '依頼中');
  out.statusReason = String(out.statusReason || '');
  out.assigneeRole = String(out.assigneeRole || '');
  out.assigneeLocation = String(out.assigneeLocation || '');
  out.taskSite = String(out.taskSite || '');
  out.temaCheck = String(out.temaCheck || '');
  return out;
}

export function rowToValues(row) {
  const n = normalizeRow(row);
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
