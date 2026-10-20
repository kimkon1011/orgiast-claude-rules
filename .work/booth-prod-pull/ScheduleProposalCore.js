/**
 * ScheduleProposalCore.js - 面談日程候補の選定と返信文生成の純粋関数ロジック
 * (node --test で実行可能)
 */

var _SP_CIRCLE_NUMS = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
var _SP_DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 0始まりまたは1始まりの数値を丸数字にする
 */
function ScheduleProposal_circleNum(n) {
  var num = Number(n);
  if (num >= 0 && num < _SP_CIRCLE_NUMS.length) return _SP_CIRCLE_NUMS[num];
  return '(' + num + ')';
}

/**
 * 日時文字列またはDateをDateオブジェクトにパース
 * ISO文字列 '2026-10-15T11:00:00+09:00' や '2026-10-15 11:00' などを解釈
 */
function _ScheduleProposal_parseDateTime(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var s = String(val).trim();
  // '2026-10-15 11:00' -> '2026-10-15T11:00:00+09:00'
  var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(s);
  if (m) {
    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);
    var hour = m[4] ? Number(m[4]) : 0;
    var min = m[5] ? Number(m[5]) : 0;
    var sec = m[6] ? Number(m[6]) : 0;
    // JSTとしてパース (UTC時間に換算: -9時間)
    return new Date(Date.UTC(year, month - 1, day, hour - 9, min, sec));
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * JST基準のYYYY-MM-DD文字列を取得
 */
function _ScheduleProposal_toDateStr(dt) {
  if (!dt) return '';
  var jst = new Date(dt.getTime() + 9 * 3600000);
  var y = jst.getUTCFullYear();
  var m = ('0' + (jst.getUTCMonth() + 1)).slice(-2);
  var d = ('0' + jst.getUTCDate()).slice(-2);
  return y + '-' + m + '-' + d;
}

/**
 * JST基準の時刻（HH:mm）を取得
 */
function _ScheduleProposal_toTimeStr(dt) {
  if (!dt) return '';
  var jst = new Date(dt.getTime() + 9 * 3600000);
  var h = ('0' + jst.getUTCHours()).slice(-2);
  var m = ('0' + jst.getUTCMinutes()).slice(-2);
  return h + ':' + m;
}

/**
 * JST基準の曜日（0=日, 1=月, ..., 6=土）を取得
 */
function _ScheduleProposal_getDayOfWeek(dt) {
  var jst = new Date(dt.getTime() + 9 * 3600000);
  return jst.getUTCDay();
}

/**
 * JST基準の時（0〜23）を取得
 */
function _ScheduleProposal_getJstHour(dt) {
  var jst = new Date(dt.getTime() + 9 * 3600000);
  return jst.getUTCHours();
}

/**
 * 2つの時間区間が重なる（オーバーラップする）かを判定
 * ※ 境界接点 (a.end === b.start または a.start === b.end) は重なりとみなさない
 * ※ ただし 30 分でも重なる場合は true
 */
function _ScheduleProposal_isOverlap(s1, e1, s2, e2) {
  var tStart1 = s1.getTime();
  var tEnd1 = e1.getTime();
  var tStart2 = s2.getTime();
  var tEnd2 = e2.getTime();

  var overlapMs = Math.min(tEnd1, tEnd2) - Math.max(tStart1, tStart2);
  // 1分以上（ミリ秒 > 0）重なっていれば重なりと判定
  return overlapMs > 0;
}

/**
 * 候補枠の表示ラベル「10/15(水) 11:00〜12:00」を生成
 */
function _ScheduleProposal_formatSlotLabel(startDt, endDt) {
  var jst = new Date(startDt.getTime() + 9 * 3600000);
  var m = jst.getUTCMonth() + 1;
  var d = jst.getUTCDate();
  var dayName = _SP_DAY_NAMES[jst.getUTCDay()];
  var startStr = _ScheduleProposal_toTimeStr(startDt);
  var endStr = _ScheduleProposal_toTimeStr(endDt);
  return m + '/' + d + '(' + dayName + ') ' + startStr + '〜' + endStr;
}

/**
 * 候補枠一覧を「①10/15(水) 11:00〜12:00」形式の行配列にする
 * @param {Array<{label: string}|string>} candidates
 * @returns {string[]}
 */
function ScheduleProposal_formatCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map(function (c, idx) {
    var num = ScheduleProposal_circleNum(idx + 1);
    var label = typeof c === 'string' ? c : (c && c.label ? c.label : '');
    return num + label;
  });
}

/**
 * 面談候補を slots と busy から選定する
 * @param {Object} params
 * @param {Array<{start: string|Date, end: string|Date, label?: string}>} params.slots - 候補枠一覧
 * @param {Array<{start: string|Date, end: string|Date}>} [params.busy] - 予定あり区間
 * @param {'am'|'pm'|''} [params.prefer] - 午前/午後優先
 * @param {string|Date} [params.today] - 基準日（これより前・過去日は除外）
 * @param {string[]|string} [params.holidays] - 祝日リスト (YYYY-MM-DD配列 または カンマ区切り)
 * @param {number} [params.count] - 最大件数 (既定 3)
 * @returns {{ ok: boolean, candidates: Array<{start: string, end: string, label: string}>, reason?: string }}
 */
function ScheduleProposal_pickCandidates(params) {
  params = params || {};
  var rawSlots = Array.isArray(params.slots) ? params.slots : [];
  var rawBusy = Array.isArray(params.busy) ? params.busy : [];
  var prefer = String(params.prefer || '').toLowerCase();
  var count = typeof params.count === 'number' && params.count > 0 ? params.count : 3;

  var todayDt = _ScheduleProposal_parseDateTime(params.today || new Date());
  var todayDateStr = _ScheduleProposal_toDateStr(todayDt);

  // 祝日セット
  var holidaySet = {};
  if (Array.isArray(params.holidays)) {
    params.holidays.forEach(function (h) {
      var s = String(h || '').trim();
      if (s) holidaySet[s] = true;
    });
  } else if (typeof params.holidays === 'string') {
    params.holidays.split(',').forEach(function (h) {
      var s = String(h || '').trim();
      if (s) holidaySet[s] = true;
    });
  }

  // busy 区間を正規化
  var busyList = [];
  rawBusy.forEach(function (b) {
    if (!b) return;
    var bs = _ScheduleProposal_parseDateTime(b.start);
    var be = _ScheduleProposal_parseDateTime(b.end);
    if (bs && be && be.getTime() > bs.getTime()) {
      busyList.push({ start: bs, end: be });
    }
  });

  // slots をフィルタリング
  var validSlots = [];
  rawSlots.forEach(function (slot) {
    if (!slot) return;
    var sDt = _ScheduleProposal_parseDateTime(slot.start);
    var eDt = _ScheduleProposal_parseDateTime(slot.end);
    if (!sDt || !eDt || eDt.getTime() <= sDt.getTime()) return;

    var dateStr = _ScheduleProposal_toDateStr(sDt);

    // 1. today 以降か判定（過去日除外）
    // 日付として today より前、または同一日でも現在時刻を過ぎている場合は除外
    if (dateStr < todayDateStr) return;
    if (sDt.getTime() < todayDt.getTime()) return;

    // 2. 土日除外
    var dayOfWeek = _ScheduleProposal_getDayOfWeek(sDt);
    if (dayOfWeek === 0 || dayOfWeek === 6) return;

    // 3. 祝日除外
    if (holidaySet[dateStr]) return;

    // 4. busy との重複除外（30分でも重なれば除外）
    var isBusy = false;
    for (var i = 0; i < busyList.length; i++) {
      if (_ScheduleProposal_isOverlap(sDt, eDt, busyList[i].start, busyList[i].end)) {
        isBusy = true;
        break;
      }
    }
    if (isBusy) return;

    var label = slot.label || _ScheduleProposal_formatSlotLabel(sDt, eDt);
    validSlots.push({
      startDt: sDt,
      endDt: eDt,
      start: sDt.toISOString(),
      end: eDt.toISOString(),
      label: label
    });
  });

  // 昇順ソート (開始日時順)
  validSlots.sort(function (a, b) {
    return a.startDt.getTime() - b.startDt.getTime();
  });

  if (validSlots.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason: 'NO_SLOT'
    };
  }

  var chosen = [];
  if (prefer === 'am' || prefer === 'pm') {
    var preferred = [];
    var other = [];
    validSlots.forEach(function (slot) {
      var hour = _ScheduleProposal_getJstHour(slot.startDt);
      var isAm = hour < 12;
      var isPreferred = (prefer === 'am' && isAm) || (prefer === 'pm' && !isAm);
      if (isPreferred) {
        preferred.push(slot);
      } else {
        other.push(slot);
      }
    });

    for (var i = 0; i < preferred.length && chosen.length < count; i++) {
      chosen.push(preferred[i]);
    }
    for (var j = 0; j < other.length && chosen.length < count; j++) {
      chosen.push(other[j]);
    }
  } else {
    for (var k = 0; k < validSlots.length && chosen.length < count; k++) {
      chosen.push(validSlots[k]);
    }
  }

  var candidates = chosen.map(function (c) {
    return {
      start: c.start,
      end: c.end,
      label: c.label
    };
  });

  return {
    ok: true,
    candidates: candidates
  };
}

/**
 * 生成した面談候補を返信案本文の末尾に差し込む
 * @param {string} replyBody
 * @param {Array<{label: string}|string>} candidates
 * @returns {{ body: string, applied: boolean }}
 */
function ScheduleProposal_applyToReply(replyBody, candidates) {
  var original = String(replyBody || '');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { body: original, applied: false };
  }

  var candidateLines = ScheduleProposal_formatCandidates(candidates);
  var proposalBlock = [
    '',
    'つきましては、下記日程にて30分〜1時間ほどオンライン面談（Google Meet）のお時間をいただけますと幸いです。',
    '',
    candidateLines.join('\n'),
    '',
    '上記日程でご都合のよろしい枠がございましたら、番号にてお知らせいただけますと幸いです。',
    '別日程のご希望がございましたら、お気軽にお申し付けください。'
  ].join('\n');

  var newBody = original ? (original.trimEnd() + '\n' + proposalBlock) : proposalBlock.trim();

  return {
    body: newBody,
    applied: true
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ScheduleProposal_circleNum: ScheduleProposal_circleNum,
    ScheduleProposal_formatCandidates: ScheduleProposal_formatCandidates,
    ScheduleProposal_pickCandidates: ScheduleProposal_pickCandidates,
    ScheduleProposal_applyToReply: ScheduleProposal_applyToReply
  };
}
