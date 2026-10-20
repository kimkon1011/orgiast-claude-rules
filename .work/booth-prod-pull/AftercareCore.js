/**
 * AftercareCore.js - 本番終了後のアフターケアの純粋関数ロジック
 * (TASK_ID: REBOOTH-T6-aftercare / node --test から import 可能)
 *
 * 設計書 docs/REBOOTH-OPS-DESIGN-2026-10-12.md §4 #11・付録 C-c/C-d が正本。
 * 反省会 → 御礼+アンケート → 報告書 → 3ヶ月後フォロー → 次回提案 の日付と文面を組み立てる。
 * GAS 依存を一切持たない (Utilities / SpreadsheetApp 等を呼ばない) ので node から検証できる。
 */

/**
 * 日本の祝日 (YYYY-MM-DD)。MVP として主要年のみを持ち、必要なら呼び出し側の holidays で上書きする。
 * NOTE: 祝日は法律・政令で追加され得るため、年 1 回は内閣府の公表値と突き合わせて更新する。
 */
var JP_HOLIDAYS = [
  // 2025
  '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
  '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05', '2025-05-06',
  '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23', '2025-10-13',
  '2025-11-03', '2025-11-23', '2025-11-24',
  // 2026
  '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20',
  '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
  '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23',
  '2026-10-12', '2026-11-03', '2026-11-23',
  // 2027
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22',
  '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11',
  '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23'
];

/** 'YYYY-MM-DD' / Date を ローカル日付の Date(時刻0時) に正規化する。 */
function _Aftercare_toDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(value || ''));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** Date → 'YYYY-MM-DD'。 */
function _Aftercare_fmt(d) {
  var y = d.getFullYear();
  var mo = ('0' + (d.getMonth() + 1)).slice(-2);
  var da = ('0' + d.getDate()).slice(-2);
  return y + '-' + mo + '-' + da;
}

function _Aftercare_addDays(d, n) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function _Aftercare_isWeekend(d) {
  var w = d.getDay();
  return w === 0 || w === 6;
}

function _Aftercare_holidaySet(extra) {
  var set = {};
  JP_HOLIDAYS.forEach(function (h) { set[h] = true; });
  if (Array.isArray(extra)) {
    extra.forEach(function (h) {
      var s = String(h || '').trim();
      if (s) set[s.slice(0, 10)] = true;
    });
  }
  return set;
}

/** その日が営業日 (土日でも祝日でもない) か。 */
function _Aftercare_isBusinessDay(d, holidaySet) {
  return !_Aftercare_isWeekend(d) && !holidaySet[_Aftercare_fmt(d)];
}

/** d 以降で最初の営業日を返す (d 自体が営業日なら d)。 */
function _Aftercare_toBusinessDay(d, holidaySet) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var guard = 0;
  while (!_Aftercare_isBusinessDay(x, holidaySet) && guard < 60) {
    x = _Aftercare_addDays(x, 1);
    guard++;
  }
  return x;
}

/**
 * アフターケアの各日付を決める。
 * - thankYouDate: 終了翌営業日 (土日祝は翌営業日へ送る)
 * - reviewDate:   終了後 7 日以内の営業日 (終了+7日を営業日へ補正)
 * - followUpDate: 終了 +90 日 (3ヶ月後の再アポ判断)
 * - nextProposalDate: 出展予測が無ければ followUpDate と同じ
 * @param {Object} caseInfo - { caseName, clientName, endDate }
 * @param {string|Date} endDate - 本番終了日 (省略時は caseInfo.endDate)
 * @param {string[]} [holidays] - 追加の祝日 (YYYY-MM-DD)。JP_HOLIDAYS に加算される
 * @returns {{ok:boolean, thankYouDate?:string, reviewDate?:string, followUpDate?:string, nextProposalDate?:string, reason?:string}}
 */
function Aftercare_schedule(caseInfo, endDate, holidays) {
  var info = caseInfo || {};
  var end = _Aftercare_toDate(endDate || info.endDate);
  if (!end) {
    return { ok: false, reason: 'END_DATE_UNKNOWN' };
  }
  var holidaySet = _Aftercare_holidaySet(holidays);

  var thankYou = _Aftercare_toBusinessDay(_Aftercare_addDays(end, 1), holidaySet);
  var review = _Aftercare_toBusinessDay(_Aftercare_addDays(end, 7), holidaySet);
  var followUp = _Aftercare_addDays(end, 90);

  return {
    ok: true,
    thankYouDate: _Aftercare_fmt(thankYou),
    reviewDate: _Aftercare_fmt(review),
    followUpDate: _Aftercare_fmt(followUp),
    nextProposalDate: _Aftercare_fmt(followUp)
  };
}

/**
 * 御礼 + アンケートの文面を組み立てる。
 * 反省会でご要望を聞く運用 (付録 C-c) に合わせ、設問は「かっこいいと思われたか / 集客の実感 / 次回の希望」。
 * @param {Object} caseInfo - { caseName, clientName, contactName }
 * @returns {{ok:boolean, subject:string, body:string, questions:string[], missing:string[]}}
 */
function Aftercare_buildThankYou(caseInfo) {
  var info = caseInfo || {};
  var missing = [];
  var caseName = String(info.caseName || '').trim();
  var clientName = String(info.clientName || '').trim();
  if (!caseName) missing.push('caseName');
  if (!clientName) missing.push('clientName');

  var honorific = String(info.contactName || '').trim() || (clientName + ' ご担当者様');
  var questions = [
    '1. ブースの見た目について、社内外で「かっこいい」という声はありましたか',
    '2. 集客・立ち寄りに手応えはありましたか（前回比でも可）',
    '3. 次回出展のご希望（時期・規模・ご予算感）があればお聞かせください'
  ];

  var subject = '【御礼】' + caseName + ' ご出展のお礼と簡単なアンケートのお願い';
  var body = [
    honorific,
    '',
    clientName + ' のみなさま',
    '',
    '先日は ' + caseName + ' にご出展いただき、誠にありがとうございました。',
    '当日は大きなトラブルなく終えることができました。皆さまのご協力に感謝いたします。',
    '',
    '今後の運営改善のため、以下 3 点だけ簡単にお聞かせいただけますと幸いです。',
    '',
    questions.join('\n'),
    '',
    'お忙しいところ恐れ入りますが、ご返信いただけますと助かります。',
    '次回のご出展についても、同じ印刷面であれば最大半額でご提案できる見込みです。',
    'どうぞお気軽にご相談ください。',
    '',
    'オージャスト'
  ].join('\n');

  return {
    ok: missing.length === 0,
    subject: subject,
    body: body,
    questions: questions,
    missing: missing
  };
}

/**
 * 次回提案レコードを組み立てる。営業アプリ (Supabase) 連携が無い時のフォールバック記録にも使う。
 * @param {Object} caseInfo - { caseName, clientName, endDate }
 * @param {Object} [prediction] - { nextProposalDate, reason } 出展予測。無ければ終了+90日
 * @returns {Object} { product_type, clientName, prevEndDate, nextProposalDate, reason, caseName }
 */
function Aftercare_nextProposalRecord(caseInfo, prediction) {
  var info = caseInfo || {};
  var p = prediction || {};
  var prevEnd = _Aftercare_toDate(info.endDate);
  var followUp = prevEnd ? _Aftercare_fmt(_Aftercare_addDays(prevEnd, 90)) : '';
  var next = String(p.nextProposalDate || '').trim() || followUp;
  var reason = String(p.reason || '').trim() ||
    '同一顧客の過去出展からの目安。終了+90日で再アポ判断 (リピートは印刷面同一なら最大半額)';

  return {
    product_type: 'Reブース',
    caseName: String(info.caseName || '').trim(),
    clientName: String(info.clientName || '').trim(),
    prevEndDate: prevEnd ? _Aftercare_fmt(prevEnd) : '',
    nextProposalDate: next,
    reason: reason
  };
}

/**
 * 次回提案レコードの必須項目を検証する。
 * @returns {{ok:boolean, errors:string[]}}
 */
function Aftercare_validate(record) {
  var errors = [];
  var r = record || {};
  if (!String(r.product_type || '').trim()) errors.push('PRODUCT_TYPE_EMPTY');
  if (r.product_type && String(r.product_type).trim() !== 'Reブース') errors.push('PRODUCT_TYPE_INVALID');
  if (!String(r.clientName || '').trim()) errors.push('CLIENT_NAME_EMPTY');
  if (!String(r.nextProposalDate || '').trim()) errors.push('NEXT_PROPOSAL_DATE_EMPTY');
  if (String(r.nextProposalDate || '').trim() && !_Aftercare_toDate(r.nextProposalDate)) {
    errors.push('NEXT_PROPOSAL_DATE_INVALID');
  }
  return { ok: errors.length === 0, errors: errors };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JP_HOLIDAYS: JP_HOLIDAYS,
    Aftercare_schedule: Aftercare_schedule,
    Aftercare_buildThankYou: Aftercare_buildThankYou,
    Aftercare_nextProposalRecord: Aftercare_nextProposalRecord,
    Aftercare_validate: Aftercare_validate
  };
}
