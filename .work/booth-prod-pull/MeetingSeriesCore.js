/**
 * 打合せ系列・ネガチェックの日程計算および命名規則の純粋関数ロジック。
 * GAS 環境および Node.js 環境の両方から import/実行可能。
 */

const CIRCLE_NUMS = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function MeetingSeries_circleNum(n) {
  var num = Number(n);
  if (num >= 0 && num < CIRCLE_NUMS.length) return CIRCLE_NUMS[num];
  return '(' + num + ')';
}

/**
 * 命名規則:
 * - kind === 'M' (顧客MTG):
 *   `M①_261019MNW_株式会社メディアネットワーク様_展示会ブース/2026年10月/Japan IT Week`
 * - kind === 'N' (ネガチェック):
 *   `【調整可】N③_261019MNW_株式会社メディアネットワーク様 _展示会ブース/2026年10月/Japan IT Week`
 *
 * customer は末尾に「様」が無ければ付与（ただし「様」を重ねない）。
 * 既存の運用実績に合わせて、Nの時は顧客名（様含む）の直後に半角スペースを置く。
 */
function MeetingSeries_eventName(kind, index, code, customer, show) {
  var cName = String(customer || '').trim();
  if (cName && !/様$/.test(cName)) cName += '様';
  var circ = MeetingSeries_circleNum(index);
  var cd = String(code || '').trim();
  var sh = String(show || '').trim();

  if (kind === 'N') {
    return '【調整可】N' + circ + '_' + cd + '_' + cName + ' _' + sh;
  }
  return 'M' + circ + '_' + cd + '_' + cName + '_' + sh;
}

/**
 * 日付（Date または YYYY-MM-DD / YYYY/MM/DD 等）を JST 基準の YYYY-MM-DD 文字列に正規化
 */
function _MeetingSeries_toDateStr(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    var jst = new Date(val.getTime() + 9 * 3600000);
    return jst.getUTCFullYear() + '-' +
      ('0' + (jst.getUTCMonth() + 1)).slice(-2) + '-' +
      ('0' + jst.getUTCDate()).slice(-2);
  }
  var s = String(val).trim();
  var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return '';
}

/**
 * YYYY-MM-DD から UTC 0:00 の Date オブジェクト（JST日付を表す）を作成
 */
function _MeetingSeries_fromStr(dateStr) {
  var parts = dateStr.split('-');
  return new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 0, 0, 0));
}

function _MeetingSeries_addDays(dateStr, days) {
  var d = _MeetingSeries_fromStr(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' +
    ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getUTCDate()).slice(-2);
}

function _MeetingSeries_diffDays(dateStr1, dateStr2) {
  var d1 = _MeetingSeries_fromStr(dateStr1);
  var d2 = _MeetingSeries_fromStr(dateStr2);
  return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}

function _MeetingSeries_isHolidayOrWeekend(dateStr, holidaySet) {
  var d = _MeetingSeries_fromStr(dateStr);
  var day = d.getUTCDay(); // 0: 日, 6: 土
  if (day === 0 || day === 6) return true;
  if (holidaySet && (holidaySet[dateStr] || (holidaySet.has && holidaySet.has(dateStr)))) return true;
  return false;
}

/** 平日判定（土日・祝日でない） */
function _MeetingSeries_isBusinessDay(dateStr, holidaySet) {
  return !_MeetingSeries_isHolidayOrWeekend(dateStr, holidaySet);
}

/** 翌営業日（当日が土日祝なら直後の平日へ、平日ならそのまま） */
function _MeetingSeries_nextBusinessDay(dateStr, holidaySet) {
  var cur = dateStr;
  while (_MeetingSeries_isHolidayOrWeekend(cur, holidaySet)) {
    cur = _MeetingSeries_addDays(cur, 1);
  }
  return cur;
}

/** 前営業日（当日が土日祝なら直前の平日へ前倒し、平日ならそのまま） */
function _MeetingSeries_prevBusinessDay(dateStr, holidaySet) {
  var cur = dateStr;
  while (_MeetingSeries_isHolidayOrWeekend(cur, holidaySet)) {
    cur = _MeetingSeries_addDays(cur, -1);
  }
  return cur;
}

/**
 * 2つの日付 (date1 < date2) の間にある営業日数を数える（date1 は含まず、date2 は含む、あるいは両端開区間など定義）
 * ここでは「間隔が 3 営業日」: N と M の間（Nの翌日〜Mの前日）に営業日が何日あるか、または M - N の営業日差。
 * 日本の一般的な「3営業日前」= Nから数えてMまでに営業日稼働が3日挟まる (例: N=木, 金=1, 月=2, 火=3 -> M=水)。
 * ここでは _MeetingSeries_businessDaysBetween(date1, date2, holidaySet):
 * date1 の翌日から date2 の前日までの営業日数
 */
function _MeetingSeries_businessDaysExclusive(date1, date2, holidaySet) {
  if (date1 >= date2) return 0;
  var count = 0;
  var cur = _MeetingSeries_addDays(date1, 1);
  while (cur < date2) {
    if (_MeetingSeries_isBusinessDay(cur, holidaySet)) {
      count++;
    }
    cur = _MeetingSeries_addDays(cur, 1);
  }
  return count;
}

/**
 * ISO 日時文字列 (JST +09:00) を生成する
 */
function _MeetingSeries_toIso(dateStr, hour, minute, durationMinutes) {
  var startH = ('0' + hour).slice(-2);
  var startM = ('0' + minute).slice(-2);
  var startIso = dateStr + 'T' + startH + ':' + startM + ':00+09:00';

  var endTotalMin = hour * 60 + minute + durationMinutes;
  var endH = ('0' + Math.floor(endTotalMin / 60)).slice(-2);
  var endM = ('0' + (endTotalMin % 60)).slice(-2);
  var endIso = dateStr + 'T' + endH + ':' + endM + ':00+09:00';

  return { start: startIso, end: endIso };
}

/**
 * 会議系列の日程を計画する純粋関数
 *
 * @param {Object} params
 *   - kickoff: キックオフ日 (Date|string)
 *   - showStart: 展示会本番開始日 (Date|string)
 *   - showEnd: 展示会本番終了日 (Date|string, 省略時は showStart)
 *   - holidays: 祝日の配列または Set/Object (['YYYY-MM-DD'] 等)
 *   - now: 現在日時 (Date|string, 省略可能)
 * @returns {Object} { meetings: [M1, M2, ...], negas: [N1, N2, ...], afterMeeting: M5, warnings: [...] }
 */
function MeetingSeries_planDates(params) {
  params = params || {};
  var warnings = [];

  var kStr = _MeetingSeries_toDateStr(params.kickoff);
  var sStartStr = _MeetingSeries_toDateStr(params.showStart);
  var sEndStr = _MeetingSeries_toDateStr(params.showEnd) || sStartStr;

  if (!kStr) throw new Error('キックオフ日が必要です');
  if (!sStartStr) throw new Error('本番開始日が必要です');

  var holidaySet = {};
  if (Array.isArray(params.holidays)) {
    params.holidays.forEach(function (h) {
      var hs = _MeetingSeries_toDateStr(h);
      if (hs) holidaySet[hs] = true;
    });
  } else if (params.holidays && typeof params.holidays === 'object') {
    Object.keys(params.holidays).forEach(function (k) {
      holidaySet[k] = true;
    });
  }

  var daysToShow = _MeetingSeries_diffDays(kStr, sStartStr);

  // 回数の決定:
  // 本番まで 28 日未満（4 回分の間隔が取れない）なら回数を 3→2 と減らし warnings に理由を残す
  var meetingCount = 4;
  if (daysToShow < 14) {
    meetingCount = 2;
    warnings.push('本番まで' + daysToShow + '日（14日未満）のため、打合せ回数を4回から2回に短縮しました');
  } else if (daysToShow < 28) {
    meetingCount = 3;
    warnings.push('本番まで' + daysToShow + '日（28日未満）のため、打合せ回数を4回から3回に短縮しました');
  }

  // 1. M_last (最終打合せ) = 本番7日前、所要30分。平日へ調整（7日前が土日祝なら前倒し平日）
  var rawFinal = _MeetingSeries_addDays(sStartStr, -7);
  var mFinalStr = _MeetingSeries_prevBusinessDay(rawFinal, holidaySet);
  if (mFinalStr <= kStr) {
    // 期間が極端に短い場合はキックオフ翌営業日〜本番前平日に収める
    mFinalStr = _MeetingSeries_prevBusinessDay(_MeetingSeries_addDays(sStartStr, -1), holidaySet);
  }

  // 2. M1 = キックオフ当日または翌営業日（平日）
  var m1Str = _MeetingSeries_nextBusinessDay(kStr, holidaySet);

  // Mの日程リスト
  var meetingDates = [];
  if (meetingCount === 2) {
    meetingDates = [m1Str, mFinalStr];
  } else if (meetingCount === 3) {
    // M1, M2, M3 (M3=mFinalStr)
    // M2 は M1 と M3 の中間日
    var diff = _MeetingSeries_diffDays(m1Str, mFinalStr);
    var midRaw = _MeetingSeries_addDays(m1Str, Math.round(diff / 2));
    var m2Str = _MeetingSeries_nextBusinessDay(midRaw, holidaySet);
    if (m2Str >= mFinalStr) m2Str = _MeetingSeries_prevBusinessDay(_MeetingSeries_addDays(mFinalStr, -1), holidaySet);
    if (m2Str <= m1Str) m2Str = _MeetingSeries_nextBusinessDay(_MeetingSeries_addDays(m1Str, 1), holidaySet);
    meetingDates = [m1Str, m2Str, mFinalStr];
  } else {
    // 4回: M1, M2, M3, M4 (M4=mFinalStr)
    var totalSpan = _MeetingSeries_diffDays(m1Str, mFinalStr);
    var step1 = Math.round(totalSpan / 3);
    var step2 = Math.round((totalSpan * 2) / 3);
    var rawM2 = _MeetingSeries_addDays(m1Str, step1);
    var rawM3 = _MeetingSeries_addDays(m1Str, step2);
    var m2 = _MeetingSeries_nextBusinessDay(rawM2, holidaySet);
    var m3 = _MeetingSeries_nextBusinessDay(rawM3, holidaySet);

    // 順序の逆転や重なりを防ぐ
    if (m2 <= m1Str) m2 = _MeetingSeries_nextBusinessDay(_MeetingSeries_addDays(m1Str, 1), holidaySet);
    if (m3 <= m2) m3 = _MeetingSeries_nextBusinessDay(_MeetingSeries_addDays(m2, 1), holidaySet);
    if (m3 >= mFinalStr) m3 = _MeetingSeries_prevBusinessDay(_MeetingSeries_addDays(mFinalStr, -1), holidaySet);
    if (m2 >= m3) m2 = _MeetingSeries_prevBusinessDay(_MeetingSeries_addDays(m3, -1), holidaySet);

    meetingDates = [m1Str, m2, m3, mFinalStr];
  }

  // 時間枠の決定: 平日 10:00〜17:00 の枠。M1..M3 は各60分、M4（最終確認）は30分
  // 規定デフォルト: 14:00〜 (M4 は 14:00〜14:30)
  var meetings = [];
  meetingDates.forEach(function (mDate, idx) {
    var isFinal = (idx === meetingDates.length - 1);
    var duration = isFinal ? 30 : 60;
    var iso = _MeetingSeries_toIso(mDate, 14, 0, duration);
    meetings.push({
      kind: 'M',
      index: idx + 1,
      date: mDate,
      start: iso.start,
      end: iso.end,
      durationMinutes: duration
    });
  });

  // 3. 各 M_k のネガチェック N_k
  // N_k = M_k の 4 日前（60分、11:00〜12:00）。
  // 土日祝に当たれば前倒し（直前平日）。
  // M_k との間隔が 3 営業日未満になる場合は M_k を後ろにずらさず N_k をさらに前倒しし、
  // それでも 3 営業日を確保できなければ warnings に記録する。
  var negas = [];
  meetings.forEach(function (mItem, idx) {
    var rawN = _MeetingSeries_addDays(mItem.date, -4);
    var nDate = _MeetingSeries_prevBusinessDay(rawN, holidaySet);

    // N と M の間の営業日数をチェック（Nの翌日〜Mの前日）
    // 「3営業日未満」の判定: NとMの間の営業日数が3日未満の場合
    // Nをさらに前倒しして 3 営業日を確保できるか試みる
    var bDays = _MeetingSeries_businessDaysExclusive(nDate, mItem.date, holidaySet);
    var attempts = 0;
    while (bDays < 3 && attempts < 10) {
      var candidateN = _MeetingSeries_prevBusinessDay(_MeetingSeries_addDays(nDate, -1), holidaySet);
      if (candidateN === nDate) break;
      nDate = candidateN;
      bDays = _MeetingSeries_businessDaysExclusive(nDate, mItem.date, holidaySet);
      attempts++;
    }

    if (bDays < 3) {
      warnings.push('N' + MeetingSeries_circleNum(idx + 1) + ' と M' + MeetingSeries_circleNum(idx + 1) + ' の間隔が ' + bDays + ' 営業日しか確保できませんでした（目標3営業日）');
    }

    var nIso = _MeetingSeries_toIso(nDate, 11, 0, 60);
    negas.push({
      kind: 'N',
      index: idx + 1,
      date: nDate,
      start: nIso.start,
      end: nIso.end,
      durationMinutes: 60,
      targetMeetingIndex: idx + 1,
      businessDaysBeforeMeeting: bDays
    });
  });

  // 4. M5（反省会）= 本番終了日の 7 日後、60 分（14:00〜15:00）。平日へ丸め（土日祝なら翌平日）
  var rawAfter = _MeetingSeries_addDays(sEndStr, 7);
  var m5Date = _MeetingSeries_nextBusinessDay(rawAfter, holidaySet);
  var m5Iso = _MeetingSeries_toIso(m5Date, 14, 0, 60);
  var afterMeeting = {
    kind: 'M',
    index: meetingCount + 1, // 通常は M5 (短縮時は M4 や M3)
    date: m5Date,
    start: m5Iso.start,
    end: m5Iso.end,
    durationMinutes: 60,
    isAfterMeeting: true
  };

  return {
    meetings: meetings,
    negas: negas,
    afterMeeting: afterMeeting,
    warnings: warnings
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MeetingSeries_circleNum: MeetingSeries_circleNum,
    MeetingSeries_eventName: MeetingSeries_eventName,
    MeetingSeries_planDates: MeetingSeries_planDates,
    _MeetingSeries_toDateStr: _MeetingSeries_toDateStr,
    _MeetingSeries_isHolidayOrWeekend: _MeetingSeries_isHolidayOrWeekend,
    _MeetingSeries_nextBusinessDay: _MeetingSeries_nextBusinessDay,
    _MeetingSeries_prevBusinessDay: _MeetingSeries_prevBusinessDay,
    _MeetingSeries_businessDaysExclusive: _MeetingSeries_businessDaysExclusive
  };
}
