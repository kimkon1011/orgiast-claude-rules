/**
 * 自社トラック(デュトロ / トヨエース / キャラバン)の使用予定を集め、案件の期間に「使用中」の車を判定する。
 *
 * 情報源(優先順):
 *   1. 倉庫稼働表 (正本。マニュアル「倉庫へのドライバー・トラック手配の依頼」が指す表)
 *      シート「シフト表：新フォーマット」 1〜2行目が見出し(2行目に列名)、A列「勤務日」で 1行=1日。
 *      列は 2行目の見出し文字列の【前方一致】で特定する(列名に改行を含む・列が増減しても追随するため)。
 *   2. 補助: 案件一覧の他案件で期間が重なるものの実施計画書「搬入出計画」シートの判定セル
 *
 * 純関数(TruckSchedule_parseRows_ / _extractTrucks_ / _extractPj_ / _computeRange_ / _describe_ / _warehouseDraftLines_)は
 * GAS に依存せず node --test で検証する。読取失敗は errors に積み、例外で全体を落とさない。
 * ※ 倉庫稼働表へは書き込まない(読取専用)。
 */

const TRUCKSCHEDULE_WAREHOUSE_SS_ID = '1wvoXJH_0hIJPean5AcrcQcAlsqtjPn7bNrJ_AECWO7Q';
const TRUCKSCHEDULE_WAREHOUSE_SHEET = 'シフト表：新フォーマット';
const TRUCKSCHEDULE_OTHER_CASE_LIMIT = 15;
const TRUCKSCHEDULE_OWN_KEYS = ['デュトロ', 'トヨエース', 'キャラバン'];

/** 倉庫稼働表の列(2行目の見出しの前方一致キー。NFKC・空白除去後に比較するので ① は 1 になる)。 */
const TRUCKSCHEDULE_COLUMNS = {
  date: '勤務日',
  own: '自社トラック',
  ownUse: '自社トラック使用予定',
  rental1: '①レンタル状況',
  rental1Use: '①トラック使用予定',
  rental2: '②レンタル状況',
  rental2Use: '②トラック使用予定'
};

function TruckSchedule_norm_(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/[\s\r\n　]+/g, '');
}

/** 車名の別名表。GAS では StaffDrivers.js の TRUCK_ALIASES を再利用し、無い環境(node)では同じ内容を使う。 */
function TruckSchedule_ownAliases_() {
  var base = (typeof TRUCK_ALIASES !== 'undefined' && TRUCK_ALIASES) ? TRUCK_ALIASES : {
    'デュトロ': ['デュトロ'], '日産キャラバン': ['キャラバン'], 'トヨエース': ['トヨエース']
  };
  var out = {};
  Object.keys(base).forEach(function (name) {
    var key = name === '日産キャラバン' ? 'キャラバン' : name;
    if (TRUCKSCHEDULE_OWN_KEYS.indexOf(key) < 0) return;
    out[key] = (out[key] || []).concat(base[name], [key]);
  });
  return out;
}

/**
 * テキストから自社トラックの車名キー(デュトロ/トヨエース/キャラバン)を拾う。
 * 「キャラバン外し」「デュトロ不要」など否定の言い回しは使用とみなさない。
 */
function TruckSchedule_extractTrucks_(text) {
  var normalized = String(text == null ? '' : text).normalize('NFKC')
    .replace(/(?:日産)?(?:デュトロ|キャラバン|トヨエース)\s*(?:外し|不要|なし|無し|以外|使わない|使用しない)/g, '');
  var aliases = TruckSchedule_ownAliases_();
  return TRUCKSCHEDULE_OWN_KEYS.filter(function (key) {
    return (aliases[key] || []).some(function (alias) {
      return normalized.indexOf(String(alias).normalize('NFKC')) >= 0;
    });
  });
}

/** PJ コード(実施計画書シート名の（）内 = YYMMDD + 英字。例 260513MAK / 2601007MED)を大文字で返す。 */
function TruckSchedule_extractPj_(text) {
  var normalized = String(text == null ? '' : text).normalize('NFKC');
  var re = /(?:^|[^A-Za-z0-9])(\d{6,7}[A-Za-z]{2,5})(?![A-Za-z0-9])/g;
  var out = [], m;
  while ((m = re.exec(normalized)) !== null) {
    var code = m[1].toUpperCase();
    if (out.indexOf(code) < 0) out.push(code);
  }
  return out;
}

/** yyyy/MM/dd へ正規化。Date(ローカル日付) / 2026/10/20 / 2026年10月20日 / 10/20(年は hintYear)。失敗は ''。 */
function TruckSchedule_normalizeDate_(value, hintYear) {
  function fmt(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
    return t.getUTCFullYear() + '/' + ('0' + (t.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + t.getUTCDate()).slice(-2);
  }
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : fmt(value.getFullYear(), value.getMonth() + 1, value.getDate());
  var text = String(value == null ? '' : value).normalize('NFKC').trim();
  var full = /(\d{4})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})/.exec(text);
  if (full) return fmt(Number(full[1]), Number(full[2]), Number(full[3]));
  var short = /(?:^|[^\d])(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})(?!\d)/.exec(text);
  if (short && hintYear) return fmt(Number(hintYear), Number(short[1]), Number(short[2]));
  return '';
}

/** yyyy/MM/dd に日数を足す。 */
function TruckSchedule_addDays_(ymd, days) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  var t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return t.getUTCFullYear() + '/' + ('0' + (t.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + t.getUTCDate()).slice(-2);
}

/** from〜to の全日(yyyy/MM/dd)。上限 maxDays(暴走防止)。 */
function TruckSchedule_eachDay_(from, to, maxDays) {
  var out = [], cur = from, limit = maxDays || 31;
  while (cur && cur <= to && out.length < limit) { out.push(cur); cur = TruckSchedule_addDays_(cur, 1); }
  return out;
}

/**
 * 案件の使用想定期間 = 設営日の前日(前日留置)〜 撤去日(最終日)。
 * 設営日が取れなければ開催初日の前日を設営日とみなす(マニュアル「設営日の記載が無ければ開催初日の前日」)。
 */
function TruckSchedule_computeRange_(startDate, endDate, setupDate) {
  var start = TruckSchedule_normalizeDate_(startDate, new Date().getFullYear());
  var hintYear = start ? Number(start.slice(0, 4)) : new Date().getFullYear();
  var end = TruckSchedule_normalizeDate_(endDate, hintYear) || start;
  var setup = TruckSchedule_normalizeDate_(setupDate, hintYear);
  var setupEstimated = false;
  if (!setup && start) { setup = TruckSchedule_addDays_(start, -1); setupEstimated = true; }
  if (!setup || !end) return null;
  var from = TruckSchedule_addDays_(setup, -1);
  return { from: from, to: end < setup ? setup : end, setupDate: setup, setupEstimated: setupEstimated };
}

/** 見出し行(配列)から列 index を引く。前方一致・NFKC・空白(改行含む)除去。見つからない列は -1。 */
function TruckSchedule_resolveColumns_(header) {
  var cells = (header || []).map(TruckSchedule_norm_);
  function find(prefix, exclude) {
    var key = TruckSchedule_norm_(prefix);
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] && cells[i].indexOf(key) === 0 && !(exclude && cells[i].indexOf(TruckSchedule_norm_(exclude)) === 0)) return i;
    }
    return -1;
  }
  var c = TRUCKSCHEDULE_COLUMNS;
  return {
    date: find(c.date),
    own: find(c.own, c.ownUse),   // 「自社トラック」(プルダウン)。「自社トラック使用予定…」と取り違えない
    ownUse: find(c.ownUse),
    rental1: find(c.rental1), rental1Use: find(c.rental1Use),
    rental2: find(c.rental2), rental2Use: find(c.rental2Use)
  };
}

function TruckSchedule_emptyBusy_() {
  var busy = {};
  TRUCKSCHEDULE_OWN_KEYS.forEach(function (key) { busy[key] = []; });
  return busy;
}

/**
 * 倉庫稼働表の行配列から、期間内に使用中の自社トラックを抽出する(純関数)。
 * @param {Array} header 列名の行(2行目)
 * @param {Array<Array>} rows データ行(日付は Date または文字列)
 * @param {{from:string,to:string}} range yyyy/MM/dd
 * @param {string} selfPj 自案件の PJ コード(その PJ の行は除外)
 * @return {{ok:boolean, busy:Object, errors:string[], rowsInRange:number}}
 */
function TruckSchedule_parseRows_(header, rows, range, selfPj) {
  var result = { ok: true, busy: TruckSchedule_emptyBusy_(), errors: [], rowsInRange: 0 };
  var col = TruckSchedule_resolveColumns_(header);
  if (col.date < 0) {
    result.ok = false;
    result.errors.push('倉庫稼働表の見出し「勤務日」が見つかりません');
    return result;
  }
  if (col.own < 0 && col.ownUse < 0) result.errors.push('倉庫稼働表の見出し「自社トラック」が見つかりません');
  var self = String(selfPj || '').toUpperCase();
  var hintYear = Number(String(range.from).slice(0, 4));
  var pairs = [[col.own, col.ownUse], [col.rental1, col.rental1Use], [col.rental2, col.rental2Use]];
  var seen = {};
  (rows || []).forEach(function (row) {
    var date = TruckSchedule_normalizeDate_(row[col.date], hintYear);
    if (!date || date < range.from || date > range.to) return;
    result.rowsInRange++;
    pairs.forEach(function (pair) {
      var texts = pair.filter(function (idx) { return idx >= 0; })
        .map(function (idx) { return String(row[idx] == null ? '' : row[idx]).replace(/\s*[\r\n]+\s*/g, ' ').trim(); })
        .filter(Boolean);
      if (!texts.length) return;
      var joined = texts.join(' ');
      var trucks = TruckSchedule_extractTrucks_(joined);
      if (!trucks.length) return;
      var pjs = TruckSchedule_extractPj_(joined);
      if (self && pjs.indexOf(self) >= 0) return; // 自案件の予定は「使用中」ではない
      trucks.forEach(function (truck) {
        var id = date + '|' + truck + '|' + pjs.join('/');
        if (seen[id]) return;
        seen[id] = true;
        result.busy[truck].push({ date: date, pj: pjs.join('/'), text: joined.slice(0, 80), source: '倉庫稼働表' });
      });
    });
  });
  return result;
}

/** 列名の行(最初の3行のうち「勤務日」を含む行)を探す。返り値は 0 始まり index、無ければ -1。 */
function TruckSchedule_findHeaderRow_(values) {
  // 実表は1行目(グループ見出し: 勤務日/出入庫予定/トラック・物流…)と2行目(列名)の両方に「勤務日」がある。
  // 最初の「勤務日」行を取ると1行目を掴み、自社トラック列が見つからず空き判定が効かなかった(2026-10-15 W2 実測)。
  // 自社トラック系の列まで引ける行を優先し、無ければ「勤務日」を含む最初の行。
  var firstDateRow = -1;
  for (var r = 0; r < Math.min(4, (values || []).length); r++) {
    var hasDate = (values[r] || []).some(function (cell) { return TruckSchedule_norm_(cell).indexOf(TRUCKSCHEDULE_COLUMNS.date) === 0; });
    if (!hasDate) continue;
    if (firstDateRow < 0) firstDateRow = r;
    var col = TruckSchedule_resolveColumns_(values[r]);
    if (col.own >= 0 || col.ownUse >= 0) return r;
  }
  return firstDateRow;
}

/** 情報源1: 倉庫稼働表(読取専用)。 */
function TruckSchedule_readWarehouse_(range, selfPj) {
  var out = { ok: false, busy: TruckSchedule_emptyBusy_(), errors: [], source: '倉庫稼働表' };
  try {
    var ss = SpreadsheetApp.openById(TRUCKSCHEDULE_WAREHOUSE_SS_ID);
    var sheet = ss.getSheetByName(TRUCKSCHEDULE_WAREHOUSE_SHEET) || ss.getSheets().filter(function (s) {
      return TruckSchedule_norm_(s.getName()).indexOf('シフト表') >= 0;
    })[0];
    if (!sheet) { out.errors.push('倉庫稼働表にシート「' + TRUCKSCHEDULE_WAREHOUSE_SHEET + '」がありません'); return out; }
    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 3 || lastCol < 1) { out.errors.push('倉庫稼働表が空です'); return out; }
    var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    var headerIndex = TruckSchedule_findHeaderRow_(values);
    if (headerIndex < 0) { out.errors.push('倉庫稼働表の見出し行(勤務日)が1〜3行目に見つかりません'); return out; }
    var parsed = TruckSchedule_parseRows_(values[headerIndex], values.slice(headerIndex + 1), range, selfPj);
    out.ok = parsed.ok;
    out.busy = parsed.busy;
    out.errors = parsed.errors;
    out.rowsInRange = parsed.rowsInRange;
  } catch (e) {
    out.errors.push('倉庫稼働表を読めません: ' + String(e && e.message ? e.message : e).slice(0, 120));
  }
  return out;
}

/**
 * 他案件の「搬入出計画」シートの判定テキストから使用予定の自社便を拾う(純関数)。
 * 空き加味の推奨行があればそれを、無ければ「判定」/「トラック判定」行の値を使う。
 * @param {Array<Array>} rows シートの表示値
 */
function TruckSchedule_planTextFromRows_(rows) {
  var text = '';
  var labels = ['推奨車両（空き加味・自動）', 'トラック判定', '判定'];
  for (var l = 0; l < labels.length && !text; l++) {
    (rows || []).some(function (row) {
      var idx = row.findIndex(function (cell) { return TruckSchedule_norm_(cell) === TruckSchedule_norm_(labels[l]); });
      if (idx < 0) return false;
      text = String(row[idx + 1] || '');
      return !!text;
    });
  }
  return text;
}

/** 案件一覧の2期間(yyyy/MM/dd)が重なるか。 */
function TruckSchedule_overlaps_(aFrom, aTo, bFrom, bTo) {
  return !!(aFrom && aTo && bFrom && bTo) && aFrom <= bTo && bFrom <= aTo;
}

/** 情報源2(補助): 期間が重なる他案件の搬入出計画シート。開くのは最大 TRUCKSCHEDULE_OTHER_CASE_LIMIT 件。 */
function TruckSchedule_readOtherCases_(range, selfCaseId, selfPj) {
  var out = { ok: false, busy: TruckSchedule_emptyBusy_(), errors: [], source: '他案件の搬入出計画', opened: 0, candidates: 0 };
  try {
    var cases = CaseList_listAll(true);
    var hintYear = Number(String(range.from).slice(0, 4));
    var candidates = cases.filter(function (c) {
      if (String(c.caseId) === String(selfCaseId)) return false;
      var s = TruckSchedule_normalizeDate_(c.startDate, hintYear), e = TruckSchedule_normalizeDate_(c.endDate, hintYear) || s;
      if (!s) return false;
      // startDate-2 〜 endDate+1 で粗く絞る
      return TruckSchedule_overlaps_(TruckSchedule_addDays_(s, -2), TruckSchedule_addDays_(e, 1), range.from, range.to);
    });
    out.candidates = candidates.length;
    out.ok = true;
    candidates.slice(0, TRUCKSCHEDULE_OTHER_CASE_LIMIT).forEach(function (c) {
      try {
        var full = CaseList_getById(c.caseId);
        if (!full || !full.zissiId) return;
        var ss = SpreadsheetApp.openById(full.zissiId);
        out.opened++;
        var codeMatch = ss.getName().match(/（([A-Za-z0-9]+)_/);
        var pj = codeMatch ? codeMatch[1].toUpperCase() : '';
        if (pj && selfPj && pj === String(selfPj).toUpperCase()) return;
        var sheet = ss.getSheetByName('搬入出計画');
        if (!sheet) return;
        var text = TruckSchedule_planTextFromRows_(sheet.getDataRange().getDisplayValues());
        var trucks = TruckSchedule_extractTrucks_(text);
        if (!trucks.length) return;
        var s = TruckSchedule_normalizeDate_(c.startDate, hintYear), e = TruckSchedule_normalizeDate_(c.endDate, hintYear) || s;
        var from = TruckSchedule_addDays_(s, -1) > range.from ? TruckSchedule_addDays_(s, -1) : range.from;
        var to = e < range.to ? e : range.to;
        TruckSchedule_eachDay_(from, to, 14).forEach(function (date) {
          trucks.forEach(function (truck) {
            out.busy[truck].push({ date: date, pj: pj, text: ('他案件「' + c.caseName + '」の搬入出計画: ' + text).slice(0, 80), source: '他案件の搬入出計画' });
          });
        });
      } catch (err) {
        out.errors.push('他案件(' + c.caseId + ')の搬入出計画を読めません: ' + String(err && err.message ? err.message : err).slice(0, 80));
      }
    });
    if (candidates.length > TRUCKSCHEDULE_OTHER_CASE_LIMIT) {
      out.errors.push('期間が重なる他案件が ' + candidates.length + ' 件あり、上限 ' + TRUCKSCHEDULE_OTHER_CASE_LIMIT + ' 件だけ確認しました');
    }
  } catch (e) {
    out.errors.push('他案件の一覧を読めません: ' + String(e && e.message ? e.message : e).slice(0, 120));
  }
  return out;
}

/** 2つの busy を、同じ 日付+車+PJ の重複を除いて合わせる(倉庫稼働表の記載を優先して残す)。 */
function TruckSchedule_mergeBusy_(primary, secondary) {
  var merged = TruckSchedule_emptyBusy_();
  TRUCKSCHEDULE_OWN_KEYS.forEach(function (key) {
    var seen = {};
    (primary[key] || []).concat(secondary[key] || []).forEach(function (entry) {
      var id = entry.date + '|' + entry.pj;
      if (entry.pj && seen[id]) return;
      if (entry.pj) seen[id] = true;
      merged[key].push(entry);
    });
    merged[key].sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  });
  return merged;
}

/**
 * 自社トラックの使用中を返す。
 * @param {{from:string,to:string}} range
 * @param {string} selfPjCode 自案件の PJ コード(空でも可)
 * @param {{selfCaseId?:string, skipOtherCases?:boolean}} opts
 * @return {{ok:boolean, source:string[], busy:Object, errors:string[]}}
 */
function TruckSchedule_busyOwnTrucks(range, selfPjCode, opts) {
  opts = opts || {};
  var errors = [], sources = [];
  var warehouse = TruckSchedule_readWarehouse_(range, selfPjCode);
  errors = errors.concat(warehouse.errors);
  if (warehouse.ok) sources.push('倉庫稼働表');
  var other = { ok: false, busy: TruckSchedule_emptyBusy_(), errors: [] };
  if (!opts.skipOtherCases) {
    other = TruckSchedule_readOtherCases_(range, opts.selfCaseId, selfPjCode);
    errors = errors.concat(other.errors);
    if (other.ok) sources.push('他案件の搬入出計画');
  }
  // 他案件の判定セルは空きを加味しない旧式の結果(毎回「デュトロ+キャラバン」)のことがあり、使用中に数えると
  // 空いている自社便を外してレンタルを勧めてしまう。倉庫稼働表が読めたらそれだけで判定し、他案件は参考表示に留める。
  if (warehouse.ok) {
    return { ok: true, source: sources, busy: warehouse.busy, hints: other.busy, errors: errors };
  }
  return { ok: other.ok, source: sources, busy: other.busy, hints: TruckSchedule_emptyBusy_(), errors: errors };
}

/**
 * 案件1件ぶんの空き判定を一括で行う(搬入出計画の生成から呼ぶ)。例外は投げず ok:false で返す。
 * PJ コードは CaseApi_readOverview の caseCode(実施計画書ブック名の「（英数字_」)。
 */
function TruckSchedule_forCase(c) {
  var info = { ok: false, range: null, selfPj: '', busy: TruckSchedule_emptyBusy_(), source: [], errors: [] };
  try {
    var setupDate = '';
    try { setupDate = (Checklist_withSetupDates([c])[0] || {}).setupDate || ''; } catch (e) { setupDate = ''; }
    info.range = TruckSchedule_computeRange_(c.startDate, c.endDate, setupDate);
    if (!info.range) { info.errors.push('案件の開催日が取れないため空きを判定できません'); return info; }
    try { info.selfPj = CaseApi_readOverview(c).caseCode || ''; } catch (e) { info.selfPj = ''; }
    if (!info.selfPj) info.errors.push('自案件の PJ コードを実施計画書名から取れませんでした（自案件の予定を除外できない可能性）');
    var res = TruckSchedule_busyOwnTrucks(info.range, info.selfPj, { selfCaseId: c.caseId });
    info.ok = res.ok; info.busy = res.busy; info.hints = res.hints; info.source = res.source; info.errors = info.errors.concat(res.errors);
  } catch (e) {
    info.errors.push(String(e && e.message ? e.message : e).slice(0, 160));
  }
  return info;
}

function TruckSchedule_md_(ymd) {
  var m = /^\d{4}\/(\d{2})\/(\d{2})$/.exec(String(ymd || ''));
  return m ? Number(m[1]) + '/' + Number(m[2]) : String(ymd || '');
}

/**
 * Doc/シートに出す「■ 自社トラックの空き状況」節(純関数)。
 * @param {object} info TruckSchedule_forCase の戻り値(range, selfPj, busy, source, errors, ok)
 * @param {object} selection Phase2_selectTrucks の戻り値(reasons / selectedTrucks)
 */
function TruckSchedule_describe_(info, selection) {
  var lines = ['■ 自社トラックの空き状況（倉庫稼働表・他案件）'];
  if (!info || !info.range) {
    lines.push('  ・ 判定できませんでした: ' + ((info && info.errors && info.errors[0]) || '期間が取れません'));
    return lines;
  }
  lines.push('  ・ 対象期間: ' + info.range.from + ' 〜 ' + info.range.to + '（設営日 ' + info.range.setupDate + (info.range.setupEstimated ? '＝開催初日の前日とみなし' : '') + ' の前日留置〜撤去日）');
  lines.push('  ・ 自案件 PJ コード: ' + (info.selfPj || '不明（実施計画書名の（）内から取得できず）') + '　情報源: ' + ((info.source || []).join(' / ') || '取得できず'));
  TRUCKSCHEDULE_OWN_KEYS.forEach(function (key) {
    var entries = (info.busy && info.busy[key]) || [];
    if (!entries.length) { lines.push('  ・ ' + key + ': 空き'); return; }
    var shown = entries.slice(0, 6).map(function (e) {
      return TruckSchedule_md_(e.date) + ' ' + (e.pj || 'PJ不明') + '（' + e.source + '）';
    }).join('、');
    lines.push('  ・ ' + key + ': 使用中 — ' + shown + (entries.length > 6 ? ' ほか' + (entries.length - 6) + '件' : ''));
  });
  TRUCKSCHEDULE_OWN_KEYS.forEach(function (key) {
    var hints = (info.hints && info.hints[key]) || [];
    if (!hints.length) return;
    var pjs = hints.map(function (e) { return e.pj || 'PJ不明'; }).filter(function (p, i, a) { return a.indexOf(p) === i; });
    lines.push('  ・ 参考: ' + key + ' は期間が重なる他案件（' + pjs.slice(0, 4).join('、') + '）の搬入出計画にも記載あり。倉庫稼働表に未記入なら手配漏れの可能性があるので確認してください');
  });
  if (selection && selection.availabilityApplied) {
    (selection.reasons || []).forEach(function (r) { lines.push('  ・ 選定理由: ' + r); });
  } else {
    lines.push('  ・ 空き状況を取得できなかったため、従来の優先順（デュトロ→キャラバン→レンタル）で選定しています');
  }
  (info.errors || []).forEach(function (e) { lines.push('  ※ ' + e); });
  lines.push('  ※ 自社便の使用予定の正本は倉庫稼働表です。最終確認は表を直接見てください: https://docs.google.com/spreadsheets/d/' + TRUCKSCHEDULE_WAREHOUSE_SS_ID + '/edit');
  lines.push('');
  return lines;
}

/**
 * 「■ 倉庫稼働表に書く内容（案）」節(純関数)。倉庫稼働表には書き込まない。日付ごとに
 * 「自社トラック=車種」「使用予定時間/PJコード/ドライバーアサイン状況」の案を出す。
 * @param {object} info range / selfPj
 * @param {Array} selectedTrucks 選定結果(自社便だけ使う)
 * @param {Object<string,string>} driverByTruck 車名→ドライバー名(未アサインは空)
 */
function TruckSchedule_warehouseDraftLines_(info, selectedTrucks, driverByTruck) {
  var lines = ['■ 倉庫稼働表に書く内容（案）※倉庫稼働表には書き込んでいません'];
  if (!info || !info.range) { lines.push('  ・ 期間が取れないため案を作れません'); lines.push(''); return lines; }
  var own = (selectedTrucks || []).filter(function (t) { return t.kind === '自社便'; });
  var rentals = (selectedTrucks || []).filter(function (t) { return t.kind === 'レンタル'; });
  var pj = info.selfPj || '（PJコード未取得）';
  var days = TruckSchedule_eachDay_(info.range.from, info.range.to, 14);
  lines.push('  ・ 記入先: 倉庫稼働表「' + TRUCKSCHEDULE_WAREHOUSE_SHEET + '」 https://docs.google.com/spreadsheets/d/' + TRUCKSCHEDULE_WAREHOUSE_SS_ID + '/edit');
  if (!own.length) lines.push('  ・ 自社トラックは使いません（自社トラック列の記入なし）');
  own.forEach(function (t) {
    var key = t.name === '日産キャラバン' ? 'キャラバン' : t.name;
    var driver = (driverByTruck && (driverByTruck[key] || driverByTruck[t.name])) || 'ドライバー未アサイン';
    lines.push('  【' + key + '】');
    days.forEach(function (date) {
      var role = date === info.range.from ? '前日留置（会場近くへ回送・時間は要確認）'
        : date === info.range.setupDate ? '搬入・設営（倉庫出発時刻は要確認）'
        : date === info.range.to ? '撤去・搬出 → 倉庫へ戻す（時刻は要確認）' : '会場近くに留置';
      lines.push('    ' + TruckSchedule_md_(date) + ' 自社トラック=' + key + ' / 使用予定時間・PJコード・ドライバー: ' + role + ' / ' + pj + ' / ' + driver);
    });
  });
  if (rentals.length) {
    var names = {};
    rentals.forEach(function (t) { names[t.name] = (names[t.name] || 0) + 1; });
    lines.push('  【レンタル】' + Object.keys(names).map(function (n) { return n + ' × ' + names[n]; }).join('、') + ' → 手配後に「①レンタル状況」「①トラック使用予定時間/PJコード/ドライバーアサイン状況」へ（②が必要なら②へ）');
  }
  lines.push('');
  return lines;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  TruckSchedule_parseRows_: TruckSchedule_parseRows_,
  TruckSchedule_extractTrucks_: TruckSchedule_extractTrucks_,
  TruckSchedule_extractPj_: TruckSchedule_extractPj_,
  TruckSchedule_resolveColumns_: TruckSchedule_resolveColumns_,
  TruckSchedule_findHeaderRow_: TruckSchedule_findHeaderRow_,
  TruckSchedule_normalizeDate_: TruckSchedule_normalizeDate_,
  TruckSchedule_computeRange_: TruckSchedule_computeRange_,
  TruckSchedule_eachDay_: TruckSchedule_eachDay_,
  TruckSchedule_planTextFromRows_: TruckSchedule_planTextFromRows_,
  TruckSchedule_mergeBusy_: TruckSchedule_mergeBusy_,
  TruckSchedule_describe_: TruckSchedule_describe_,
  TruckSchedule_warehouseDraftLines_: TruckSchedule_warehouseDraftLines_
};
