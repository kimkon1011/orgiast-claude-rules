// 送信前の8項目。外部I/Oを持たず、取得不能と空の履歴を区別する。
export const normalizeSubject = value => String(value ?? '').normalize('NFKC').replace(/(?:(?:re|fwd?)\s*:|\s)/gi, '').toLowerCase();
export const addresses = value => (Array.isArray(value) ? value : [value]).flatMap(v => String(v ?? '').split(/[,;]+/)).map(v => (v.match(/<([^>]+)>/)?.[1] || v).trim().toLowerCase()).filter(Boolean);
// required: 常に照合。optional: readerを持たない経路だけ警告、readerの取得失敗は停止。
// LINEはSupabase、BeeperはローカルAPIの履歴readerが既に存在するため、未対応と決めつけない。
const commonSupport = { sentHistory: 'required', recentSent: 'required', followupLedger: 'required', scheduledSends: 'required', otherPcState: 'required', directives: 'required', calendarEvents: 'required', requiredCc: 'required', draftReadAt: 'required' };
export const CHANNEL_ITEM_SUPPORT = Object.freeze({
  gmail: Object.freeze({ ...commonSupport, otherDrafts: 'required', threadMessages: 'required' }),
  discord: Object.freeze({ ...commonSupport, otherDrafts: 'unsupported', threadMessages: 'required' }),
  line: Object.freeze({ ...commonSupport, otherDrafts: 'unsupported', threadMessages: 'optional', draftReadAt: 'optional' }),
  beeper: Object.freeze({ ...commonSupport, otherDrafts: 'unsupported', threadMessages: 'optional', draftReadAt: 'optional' }),
});
export const CONSISTENCY_ITEM = Object.freeze({ sentHistory: 1, followupLedger: 1, scheduledSends: 2, otherDrafts: 2, otherPcState: 2, calendarEvents: 3, requiredCc: 3, directives: 5, threadMessages: 7, draftReadAt: 7, recentSent: 8 });
const sameTo = (a, b) => addresses(a).some(v => addresses(b).includes(v));
const bodyOf = row => String(row.text ?? row.body ?? '');
const atOf = row => Date.parse(row.at ?? row.sentAt ?? row.timestamp ?? '');
export function similarity(a, b) {
  const grams = s => { const t = String(s).normalize('NFKC').replace(/\s/g, ''); return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2))); };
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = grams(a), y = grams(b);
  return x.size + y.size ? 2 * [...x].filter(g => y.has(g)).length / (x.size + y.size) : 0;
}
export function datesIn(text, now, futureYear = false) {
  const year = new Date(Number(now) + 9 * 3600000).getUTCFullYear();
  const re = /(?:(\d{4})[\/年-])?(\d{1,2})[\/月-](\d{1,2})(?:日)?(?:\s*[（(]?([日月火水木金土])(?:曜日|曜)?[）)]?)?(?:\s*(\d{1,2})(?::|時)(\d{1,2})?(?:分)?)?/g;
  return [...String(text).matchAll(re)].flatMap(m => {
    const make = y => Date.UTC(y, +m[2] - 1, +m[3], +(m[5] || 0) - 9, +(m[6] || 0));
    let y = +(m[1] || year);
    if (!m[1]) {
      const candidates = [year - 1, year, year + 1];
      y = futureYear ? candidates.filter(v => make(v) + 86400000 > +now).sort((a,b) => make(a)-make(b))[0] : candidates.sort((a,b) => Math.abs(make(a)-now)-Math.abs(make(b)-now))[0];
    }
    const at = make(y), local = new Date(at + 9 * 3600000);
    if (local.getUTCMonth() !== +m[2] - 1 || local.getUTCDate() !== +m[3]) return [];
    return [{ at, raw: m[0], weekday: m[4], actualWeekday: '日月火水木金土'[local.getUTCDay()], timed: Boolean(m[5]), key: `${+m[2]}/${+m[3]}` }];
  });
}
function facts(text, now) {
  return {
    date: datesIn(text, now).map(d => d.key),
    time: [...text.matchAll(/(\d{1,2})(?::|時)(\d{1,2})?(?:分)?/g)].map(m => `${+m[1]}:${+(m[2] || 0)}`),
    amount: [...text.matchAll(/([\d,]+(?:\.\d+)?)(万)?円/g)].map(m => String(Number(m[1].replace(/,/g,'')) * (m[2] ? 10000 : 1))),
    quantity: [...text.matchAll(/(\d+)\s*(個|名|人|台|本|枚|件)/g)].map(m => `${+m[1]}${m[2]}`),
  };
}
function conflict(a, b, now) {
  const x = facts(a, now), y = facts(b, now);
  return Object.keys(x).filter(k => x[k].length && y[k].length && x[k].some(v => !y[k].includes(v)));
}
export function checkSendConsistency(input = {}, opts = input.opts || {}) {
  const findings = [], now = new Date(input.now ?? Date.now()).getTime(), text = String(input.text ?? '');
  const add = (code, item, where, expected, actual, message = code, extra = {}) => findings.push({ code, item, where, expected, actual, message, ...extra });
  for (const field of input.unverified || []) {
    add(`UNVERIFIED_${field}`, CONSISTENCY_ITEM[field] || 3, field, '照合済み', '取得不能', '実装済みの読み取りに失敗したため停止');
  }
  for (const field of input.unsupported || []) {
    const support = CHANNEL_ITEM_SUPPORT[input.channel]?.[field];
    const warning = support === 'optional' || support === 'unsupported';
    add(`${warning ? 'UNSUPPORTED' : 'UNVERIFIED'}_${field}`, CONSISTENCY_ITEM[field] || 3, field, '照合済み', '読み取り未対応', `未確認: ${field}（${input.channel}は読み取り未対応）`, warning ? { severity: 'warning' } : {});
  }
  const subjectMatches = row => Boolean(normalizeSubject(input.subject)) && normalizeSubject(row.subject) === normalizeSubject(input.subject);
  for (const row of input.recentSent || []) {
    const at = atOf(row);
    if (now >= at && now - at <= 600000 && ((input.draftId && row.draftId === input.draftId) || (sameTo(input.to, row.to) && (subjectMatches(row) || (normalizeSubject(input.subject) && input.subjectHash && row.subjectHash === input.subjectHash) || similarity(text, bodyOf(row)) >= .8)))) add('DUP_SENT_BY_USER', 8, `${row.at || row.sentAt} From: ${row.sender || row.from || row.account || '不明'}`, '未送信', row.subject || row.draftId || row.subjectHash, '直前10分に同じ宛先・件名が送信済みです');
  }
  for (const row of input.sentHistory || []) {
    const duplicateId = input.draftId && row.draftId === input.draftId;
    const at = atOf(row), recent = Number.isFinite(at) && at <= now && now-at <= 14*86400000;
    if (duplicateId || (recent && sameTo(input.to,row.to) && (subjectMatches(row) || similarity(text,bodyOf(row)) >= .8 || (normalizeSubject(input.subject) && input.subjectHash && row.subjectHash === input.subjectHash)))) add('DUP_ALREADY_SENT',1,row.where || row.account || row.draftId || row.at,'未送信',row.subject || row.draftId || bodyOf(row),'同じ用件を送信済み');
  }
  for (const row of input.scheduledSends || []) if (!['sent','done','completed','送信済み','完了'].includes(row.status) && ((input.draftId && row.draftId === input.draftId) || (sameTo(input.to,row.to) && subjectMatches(row)))) add('DUP_SCHEDULED',2,row.where || row.path || row.draftId,'送信予定なし',row.subject || row.draftId,'別の送信予定が残っています');
  for (const row of input.otherDrafts || []) if (!(input.draftId && row.draftId === input.draftId && (!row.account || !input.account || row.account === input.account)) && sameTo(input.to,row.to) && subjectMatches(row)) add('DUP_OTHER_DRAFT',2,row.where || row.account || row.draftId,'他の下書きなし',row.draftId,'同じ用件の下書きが残っています');
  for (const line of text.split(/\r?\n/)) {
    for (const d of datesIn(line, now, true)) if (d.weekday && d.weekday !== d.actualWeekday) add('DATE_WEEKDAY_MISMATCH',3,line,d.actualWeekday,d.weekday,'日付と曜日が不一致');
    if (/候補|締切|〆切|期限|まで|開催|日程|ご都合/.test(line) && !/いただいた|送付した|ありがとう|先日/.test(line)) for (const d of datesIn(line, now)) if ((d.timed ? d.at : d.at + 86400000) <= now) add('DATE_PAST',6,line,'未来の日付',d.raw,'期日が過ぎています');
  }
  const names = Array.isArray(input.knownNames) ? input.knownNames : Object.values(input.knownNames || {}).flat();
  const nameKey = v => String(v).replace(/[\s　様]/g,'');
  for (const m of text.matchAll(/^\s*([^\n、。]+?)様/gm)) if (names.length && !names.some(n => nameKey(m[1]) === nameKey(n))) add('NAME_MISMATCH',3,m[0],names.join('／'),m[1],'宛名が過去の氏名と不一致');
  for (const cc of addresses(input.requiredCc)) if (!addresses(input.cc).includes(cc)) add('CC_MISSING',3,'CC',cc,addresses(input.cc).join(',') || 'なし','必須CCがありません');
  for (const event of input.calendarEvents || []) {
    if (!(event.sameCase || (event.caseId && event.caseId === input.caseId) || (event.subject && normalizeSubject(event.subject) === normalizeSubject(input.subject)))) continue;
    const eventText = event.text || event.start?.dateTime || event.start?.date || event.start || '';
    if (conflict(text,eventText,now).length) add('CAL_MISMATCH',3,`${event.summary || event.subject}: ${eventText}\n本文: ${text}`,eventText,text,'同じ案件の予定と不一致');
  }
  for (const row of input.threadMessages || []) {
    const body = bodyOf(row), self = row.side === 'self' || row.isSelf === true || row.isSender === true || row.direction === 'outbound';
    if (self && !/変更|訂正|改めて/.test(text) && conflict(body,text,now).length) add('CONTRADICTS_PAST',4,`過去: ${body}\n本文: ${text}`,body,text,'変更の説明がありません');
    if (!self && atOf(row) > Date.parse(input.draftReadAt)) {
      add('INBOUND_NEWER',7,body,input.draftReadAt,row.at || row.timestamp,'下書き確認後に新着があります');
      if (conflict(body,text,now).length) add('INBOUND_CONFLICT',7,`新着: ${body}\n本文: ${text}`,body,text,'新着と本文が不一致');
    }
  }
  for (const d of input.directives || []) if (!d.since || Date.parse(d.since) <= now) {
    try { const match = text.match(new RegExp(d.pattern,'mu')); if (match) add('DIRECTIVE_NOT_APPLIED',5,match[0],d.message,'注記が残存',d.message); }
    catch { add('UNVERIFIED_directives',5,d.id,'有効な正規表現',d.pattern,'指示設定が不正'); }
  }
  return { ok: !findings.some(f => f.severity !== 'warning'), findings };
}
export function formatConsistencyFindings(findings) {
  return ['送信前の整合性チェック: 送信を止めました', ...findings.map(f => `(${f.item}) 食い違い: ${String(f.where).replace(/\r?\n/g,' / ')} 期待=${f.expected} 実際=${f.actual} [${f.code}${f.severity === 'warning' ? ' 警告' : ''}]`)].join('\n');
}
