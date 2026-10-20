/**
 * ドライバーの勤務時間(入時間/出時間)を実施計画書のスタッフシートへ仮記入する。
 *
 * 根拠: マニュアル「スタッフシートの更新」「スタッフの入り時間・出時間」「倉庫へのドライバー・トラック手配の依頼」。
 *  - 倉庫 = 渋井倉庫(埼玉県川越市渋井1351)。移動時間は GAS 組込みの Maps.newDirectionFinder()(車)で取得し、移動時間 + 1時間バッファ。
 *  - 搬入ドライバー: 会場到着 = 会場に入れる時刻の90分前（会場付近の駐車場に集合し、そこから車輌待機所へ向かう。2026-10-19 cr 指示で75分→90分） / 入時間 = 会場到着 −(移動 + 1h)。
 *      出時間 = ドライバー兼設営(主な業務に「設営」)なら 設営開始 + 2.5h(退館時刻指定があればその30分前を優先)、含まなければ 会場到着 + 30分。
 *  - 撤去(搬出)ドライバー: 会場到着 = 撤去開始の75分前（会場付近の駐車場に集合し、1時間前に搬入口へ） / 入時間 = 会場到着 −(移動 + 1h) /
 *      出時間 = 撤去完了(最終日終了 + 1.5h)+ 会場→倉庫の移動時間。撤去開始が取れなければ最終日終了を撤去開始とみなす(メモに明記)。
 *  - 宅配(ヤマト等)搬入ではドライバー行が無いので何もしない。取れない値は推測で埋めず、未記入の理由を返す。
 * 書込みは「空欄のセルだけ」。記入済みの時間は変えない。書いたセルには根拠をメモで残す。
 *
 * 時刻計算は純関数 Phase2_DriverHours_compute_ に分離(node --test で検証)。
 */

const DRIVERHOURS_WAREHOUSE_NAME = '渋井倉庫';
const DRIVERHOURS_WAREHOUSE_ADDRESS = '埼玉県川越市渋井1351';
const DRIVERHOURS_BUFFER_MIN = 60;
const DRIVERHOURS_ARRIVE_BEFORE_SETUP_MIN = 90; // 会場に入れる時刻の90分前(会場付近の駐車場に集合し、そこから車輌待機所へ)
const DRIVERHOURS_SETUP_WORK_MIN = 150;      // 設営開始 + 2.5h
const DRIVERHOURS_TEARDOWN_ARRIVE_MIN = -75; // 撤去開始の75分前(会場付近の駐車場に集合し、1時間前に搬入口へ)
const DRIVERHOURS_TEARDOWN_DONE_MIN = 90;    // 最終日終了 + 1.5h
const DRIVERHOURS_NOT_DRIVER_ROLE = /宅配|ヤマト|佐川|クロネコ|運送便/;

/** "9:00" "09:00" "９時30分" "9時" → 分(0-1439)。取れなければ null。 */
function Phase2_DriverHours_parseTime_(text) {
  var all = Phase2_DriverHours_allTimes_(text);
  return all.length ? all[0] : null;
}

/** テキスト中の時刻をすべて分で返す(開催時間「10:00〜17:00」の終了側を取る用)。 */
function Phase2_DriverHours_allTimes_(text) {
  var s = String(text == null ? '' : text).normalize('NFKC');
  var re = /(\d{1,2})\s*(?::|時)\s*(\d{1,2})?/g, out = [], m;
  while ((m = re.exec(s)) !== null) {
    var h = Number(m[1]), min = m[2] != null ? Number(m[2]) : 0;
    if (h <= 24 && min < 60 && !(h === 24 && min > 0)) out.push(h * 60 + min);
  }
  return out;
}

/** 分 → "HH:mm"。0〜1439 の範囲外(日付をまたぐ)は null。 */
function Phase2_DriverHours_fmtTime_(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0 || minutes >= 1440) return null;
  var h = Math.floor(minutes / 60), m = minutes % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}

function _DH_t(value) { return typeof value === 'number' ? value : Phase2_DriverHours_parseTime_(value); }

/**
 * 入時間・出時間を計算する(純関数)。
 * @param {object} inputs {
 *   leg: 'load_in'|'teardown',
 *   travelMin: 倉庫→会場の移動分(取得失敗は null), returnMin: 会場→倉庫(撤去の出時間用。失敗は null),
 *   setupStart: '10:00', teardownStart: '17:00'|null, lastDayEnd: '17:00'|null, exitDeadline: '18:00'|null,
 *   alsoSetup: true|false(主な業務に「設営」を含むか), bufferMin: 既定60 }
 * @return {{ok:boolean, leg:string, inTime:string, outTime:string, inNote:string, outNote:string, missing:string[]}}
 *   ok = 入・出の両方が出せた。片方だけでも inTime/outTime は埋まる。出せなかった側は '' と missing の理由。
 */
function Phase2_DriverHours_compute_(inputs) {
  var buffer = typeof inputs.bufferMin === 'number' ? inputs.bufferMin : DRIVERHOURS_BUFFER_MIN;
  var res = { ok: false, leg: inputs.leg, inTime: '', outTime: '', inNote: '', outNote: '', missing: [] };
  var travel = typeof inputs.travelMin === 'number' && isFinite(inputs.travelMin) ? Math.ceil(inputs.travelMin) : null;
  var back = typeof inputs.returnMin === 'number' && isFinite(inputs.returnMin) ? Math.ceil(inputs.returnMin) : null;
  var hhmm = Phase2_DriverHours_fmtTime_;
  function put(field, minutes, note) {
    var text = hhmm(minutes);
    if (text == null) { res.missing.push((field === 'in' ? '入時間' : '出時間') + 'が日付をまたぐ計算になるため要手動確認（' + note + '）'); return; }
    if (field === 'in') { res.inTime = text; res.inNote = note; } else { res.outTime = text; res.outNote = note; }
  }
  if (inputs.leg === 'load_in') {
    var setup = _DH_t(inputs.setupStart);
    if (setup == null) {
      res.missing.push('会場に入れる時刻(設営開始)が取れません');
    } else {
      var arrive = setup - DRIVERHOURS_ARRIVE_BEFORE_SETUP_MIN;
      if (travel == null) res.missing.push('倉庫→会場の移動時間を取得できません（入時間）');
      else put('in', arrive - (travel + buffer), '搬入 会場付近の駐車場に集合=会場に入れる時刻' + hhmm(setup) + 'の90分前' + hhmm(arrive) + ' − 移動' + travel + '分 − バッファ' + buffer + '分');
      var exit = _DH_t(inputs.exitDeadline);
      if (inputs.alsoSetup) {
        if (exit != null) put('out', exit - 30, '設営兼務 退館時刻' + hhmm(exit) + 'の30分前');
        else put('out', setup + DRIVERHOURS_SETUP_WORK_MIN, '設営兼務 会場に入れる時刻' + hhmm(setup) + ' + 2.5時間');
      } else {
        put('out', setup, '設営なし 会場に入れる時刻' + hhmm(setup) + '(荷下ろしまで)');
      }
    }
  } else if (inputs.leg === 'teardown') {
    var tStart = _DH_t(inputs.teardownStart), lastEnd = _DH_t(inputs.lastDayEnd);
    var substituted = false;
    if (tStart == null && lastEnd != null) { tStart = lastEnd; substituted = true; }
    if (tStart == null) {
      res.missing.push('撤去開始時刻・最終日終了時刻が取れません');
    } else {
      var arriveT = tStart + DRIVERHOURS_TEARDOWN_ARRIVE_MIN;
      var startNote = substituted ? '撤去開始時刻が取れないため最終日終了' + hhmm(tStart) + 'を撤去開始とみなし' : '撤去開始' + hhmm(tStart);
      if (travel == null) res.missing.push('倉庫→会場の移動時間を取得できません（入時間）');
      else put('in', arriveT - (travel + buffer), '撤去 ' + startNote + 'の75分前 = 会場付近の駐車場に集合' + hhmm(arriveT) + '(1時間前に搬入口へ) − 移動' + travel + '分 − バッファ' + buffer + '分');
    }
    var tDone = _DH_t(inputs.teardownDone);
    if (tDone != null && back != null) {
      // 概要の会期スケジュールに「撤収完了」がある時はそれを正とする(最終日終了+1.5h の推定より優先)
      put('out', tDone + back, '撤去完了' + hhmm(tDone) + '(概要の会期スケジュール) + 会場→倉庫の移動' + back + '分');
    } else if (lastEnd == null) {
      res.missing.push('最終日終了時刻が取れません（出時間）');
    } else if (back == null) {
      res.missing.push('会場→倉庫の移動時間を取得できません（出時間）');
    } else {
      var done = lastEnd + DRIVERHOURS_TEARDOWN_DONE_MIN;
      put('out', done + back, '撤去完了=最終日終了' + hhmm(lastEnd) + ' + 1.5時間 = ' + hhmm(done) + ' + 会場→倉庫の移動' + back + '分');
    }
  } else {
    res.missing.push('不明な区分: ' + inputs.leg);
  }
  res.ok = !!res.inTime && !!res.outTime;
  return res;
}

/** スタッフシートの表示値から、ヘッダー・日付ブロック・ドライバー行(シート行番号つき)を取る(純関数。StaffDrivers.js の関数を再利用)。 */
function Phase2_DriverHours_layout_(values) {
  var out = { found: false, dataStartIndex: -1, cols: null, dateBlocks: [], driverRows: [] };
  var rowsAll = values || [];
  var headerRow = null, dataStart = -1, blocks = [];
  for (var r = 0; r < Math.min(30, rowsAll.length); r++) {
    var row = rowsAll[r];
    if (/^(?:製作パート|主な業務\(自動\))/.test(String(row[0] || '').normalize('NFKC').trim())) break;
    var resolved = StaffDrivers_resolveColumns(row).columns;
    var headerHeight = 1;
    if (resolved.name >= 0 && resolved.tel < 0 && rowsAll[r + 1]) {
      var merged = row.map(function (cell, col) { return normalizeHeaderCell(cell) ? cell : rowsAll[r + 1][col]; });
      var combined = StaffDrivers_resolveColumns(merged).columns;
      if (combined.role >= 0 && combined.name >= 0 && combined.tel >= 0) { row = merged; resolved = combined; headerHeight = 2; }
    }
    if (resolved.role >= 0 && resolved.name >= 0 && resolved.tel >= 0) {
      headerRow = row; dataStart = r + headerHeight; blocks = StaffDrivers_dateBlocks_(rowsAll, r, row);
      out.cols = resolved;
      break;
    }
  }
  if (!headerRow) return out;
  out.found = true; out.dataStartIndex = dataStart; out.dateBlocks = blocks;
  var dataRows = StaffDrivers_blockRows_(rowsAll.slice(dataStart));
  dataRows.forEach(function (row, i) {
    var role = String(row[out.cols.role] || '').trim();
    if (!role || StaffDrivers_isDateOnly_(role)) return;
    if (role.indexOf('ドライバー') < 0 && role.indexOf('運転') < 0) return;
    var name = String(row[out.cols.name] == null ? '' : row[out.cols.name]).trim();
    out.driverRows.push({ rowNumber: dataStart + 1 + i, role: role, name: name, cells: row });
  });
  return out;
}

/** "yyyy/MM/dd" → スタッフシートの日付見出し "M月D日"。 */
function Phase2_DriverHours_blockKey_(ymd) {
  var m = /^\d{4}\/(\d{2})\/(\d{2})$/.exec(String(ymd || ''));
  return m ? Number(m[1]) + '月' + Number(m[2]) + '日' : '';
}

/** 主な業務の文言から、その行が担当する区間と設営兼務かを判定する。 */
function Phase2_DriverHours_roleLegs_(role) {
  var text = String(role || '').normalize('NFKC');
  var t = /撤去|搬出/.test(text), l = /搬入/.test(text);
  var legs = (t && !l) ? ['teardown'] : (l && !t) ? ['load_in'] : ['load_in', 'teardown'];
  return { legs: legs, alsoSetup: /設営/.test(text), skip: DRIVERHOURS_NOT_DRIVER_ROLE.test(text) };
}

/**
 * 書込み計画を作る(純関数)。空欄セルだけを writes に入れ、記入済みは unchanged に数える。
 * @param {object} layout Phase2_DriverHours_layout_ の結果
 * @param {object} ctx { dates:{load_in:'yyyy/MM/dd', teardown:'yyyy/MM/dd'}, base:{travelMin,returnMin,setupStart,teardownStart,lastDayEnd,exitDeadline}, bufferMin }
 */
function Phase2_DriverHours_plan_(layout, ctx) {
  var plan = { writes: [], unchanged: 0, unwritten: [], drivers: 0, skippedRows: [] };
  (layout.driverRows || []).forEach(function (d) {
    if (StaffDrivers_unassignedReason(d.name) === '不要') { plan.skippedRows.push(d.role + '（不要）'); return; }
    var rl = Phase2_DriverHours_roleLegs_(d.role);
    if (rl.skip) { plan.skippedRows.push(d.role + '（宅配等）'); return; }
    plan.drivers++;
    var label = d.role + (d.name && d.name !== '未アサイン' ? '(' + d.name + ')' : '');
    rl.legs.forEach(function (leg) {
      var legName = leg === 'load_in' ? '搬入' : '撤去';
      var date = ctx.dates[leg];
      var blockKey = Phase2_DriverHours_blockKey_(date);
      var block = (layout.dateBlocks || []).filter(function (b) { return b.date === blockKey; })[0];
      if (!date || !block) {
        plan.unwritten.push({ row: d.rowNumber, label: label, leg: legName, reason: legName + '日(' + (blockKey || '日付不明') + ')の入時間/出時間の列がスタッフシートにありません' });
        return;
      }
      var calc = Phase2_DriverHours_compute_(Object.assign({}, ctx.base, { leg: leg, alsoSetup: rl.alsoSetup, bufferMin: ctx.bufferMin }));
      calc.missing.forEach(function (reason) { plan.unwritten.push({ row: d.rowNumber, label: label, leg: legName, reason: reason }); });
      [['in', block.inCol, calc.inTime, calc.inNote], ['out', block.outCol, calc.outTime, calc.outNote]].forEach(function (f) {
        if (!f[2]) return;
        if (f[1] < 0) { plan.unwritten.push({ row: d.rowNumber, label: label, leg: legName, reason: legName + 'の' + (f[0] === 'in' ? '入' : '出') + '時間の列がありません' }); return; }
        var existing = String((d.cells[f[1]] == null ? '' : d.cells[f[1]])).trim();
        if (existing) { plan.unchanged++; return; }
        plan.writes.push({ row: d.rowNumber, col: f[1] + 1, value: f[2], note: 'Claude仮記入 ' + date + ': ' + f[3] });
      });
    });
  });
  return plan;
}

/** Maps.newDirectionFinder で車の所要分を取る。失敗は {minutes:null, error}。depart は Date。 */
function Phase2_DriverHours_travelMinutes_(origin, destination, depart) {
  function ask(withDepart) {
    var finder = Maps.newDirectionFinder().setOrigin(origin).setDestination(destination).setMode(Maps.DirectionFinder.Mode.DRIVING);
    if (withDepart && depart) finder.setDepart(depart);
    var data = finder.getDirections();
    var leg = data && data.routes && data.routes[0] && data.routes[0].legs && data.routes[0].legs[0];
    var seconds = leg && ((leg.duration_in_traffic && leg.duration_in_traffic.value) || (leg.duration && leg.duration.value));
    if (!seconds) throw new Error('経路が見つかりません(' + (data && data.status) + ')');
    return Math.ceil(seconds / 60);
  }
  try { return { minutes: ask(true), error: '' }; } catch (e1) {
    try { return { minutes: ask(false), error: '' }; } catch (e2) {
      return { minutes: null, error: String(e2 && e2.message ? e2.message : e2).slice(0, 100) };
    }
  }
}

/**
 * 概要シートの「ラベル → 右隣の値」から時刻・文言を拾う(純関数)。ラベルは NFKC・空白除去・前方一致。
 *
 * 同じキーに複数のラベル候補がある場合(例: 入館可能 / 入場可能 / 搬入開始 / 設営開始)は、
 * **labelMap の配列順を優先順として扱う**。先に現れたセルで確定させると、シートの並び順だけで
 * 「会場に入れる時刻」と「設営開始時刻」を取り違えるため(2026-10-13 修正)。
 * 同じ優先度の候補が複数あるときは従来どおり先に現れたセルを使う。
 */
function Phase2_DriverHours_scanLabels_(values, labelMap) {
  var found = {};
  var rank = {}; // 採用済みラベルの優先度(配列の添字)。小さいほど優先。
  (values || []).forEach(function (row) {
    row.forEach(function (cell, col) {
      var label = String(cell == null ? '' : cell).normalize('NFKC').replace(/[\s　]+/g, '').replace(/[:：]$/, '');
      if (!label) return;
      Object.keys(labelMap).forEach(function (key) {
        var candidates = labelMap[key] || [];
        var matched = -1;
        for (var li = 0; li < candidates.length; li++) {
          if (label.indexOf(candidates[li]) === 0) { matched = li; break; }
        }
        if (matched < 0) return;
        if (rank[key] != null && rank[key] <= matched) return;
        var parts = [];
        for (var j = col + 1; j < row.length && parts.length < 3; j++) {
          var v = String(row[j] == null ? '' : row[j]).trim();
          if (v) parts.push(v);
        }
        if (parts.length) { found[key] = parts.join(' '); rank[key] = matched; }
      });
    });
  });
  return found;
}

/**
 * 概要シートの「■会期スケジュール」表(見出し 日程 / 時間 / 内容)から時刻を拾う(純関数)。
 * 実施計画書の多くは「撤去開始」等のラベルを持たず、時刻はこの表にしか無い(2026-10-15 W2 実測:
 * 撤収 17:00 撤収作業 / 22:00 撤収完了、本番日③ 17:00 展示終了)。日程列は区分の先頭行だけ埋まる。
 * @return {{setupStart:number|null, teardownStart:number|null, teardownDone:number|null, lastDayEnd:number|null}}
 */
function Phase2_DriverHours_scanSchedule_(values) {
  var out = { setupStart: null, teardownStart: null, teardownDone: null, lastDayEnd: null };
  var rows = values || [];
  function norm(v) { return String(v == null ? '' : v).normalize('NFKC').replace(/[\s　]+/g, ''); }
  var headerIndex = -1, dayCol = -1, timeCol = -1, descCol = -1;
  for (var r = 0; r < rows.length && headerIndex < 0; r++) {
    var cells = (rows[r] || []).map(norm);
    var d = cells.indexOf('日程'), t = cells.indexOf('時間'), x = cells.indexOf('内容');
    if (d >= 0 && t >= 0 && x >= 0) { headerIndex = r; dayCol = d; timeCol = t; descCol = x; }
  }
  if (headerIndex < 0) return out;
  var group = '';
  for (var i = headerIndex + 1; i < rows.length; i++) {
    var row = rows[i] || [];
    var day = norm(row[dayCol]);
    if (day) group = day;
    var time = Phase2_DriverHours_parseTime_(String(row[timeCol] == null ? '' : row[timeCol]));
    var desc = norm(row[descCol]);
    if (time == null || !desc) continue;
    if (/撤収|撤去|搬出/.test(group)) {
      if (/完了/.test(desc)) { if (out.teardownDone == null) out.teardownDone = time; }
      else if (out.teardownStart == null) out.teardownStart = time;
    } else if (/本番|会期|開催/.test(group)) {
      if (/展示終了|終了|閉場/.test(desc)) out.lastDayEnd = time; // 最後の本番日の値で上書きされる
    } else if (/設営/.test(group) && out.setupStart == null && /設営開始|搬入開始/.test(desc)) {
      out.setupStart = time;
    }
  }
  return out;
}

const DRIVERHOURS_LABELS = {
  setupStart: ['入館可能', '入場可能', '入館時間', '入館時刻', '搬入開始', '設営開始'],
  setupDay2Start: ['設営2日目', '2日目入館', '2日目搬入', '2日目設営'],
  teardownStart: ['撤去開始', '撤収開始', '搬出開始'],
  lastDayEnd: ['最終日終了', '閉場時刻', '閉場時間'],
  exitDeadline: ['退館時刻', '退館時間', '退館'],
  eventHours: ['開催時間', '開催時刻']
};

/** 案件から計算に必要な値を集める。取れないものは null/'' のまま(推測で埋めない)。 */
function Phase2_DriverHours_gatherInputs_(c) {
  var read = CaseApi_readOverview(c);
  var overview = read.overview || {};
  var sheet = read.zissi && (read.zissi.getSheetByName('概要') || read.zissi.getSheets().filter(function (s) { return s.getName().indexOf('概要') >= 0; })[0]);
  var overviewValues = sheet ? sheet.getDataRange().getDisplayValues() : [];
  var labeled = sheet ? Phase2_DriverHours_scanLabels_(overviewValues, DRIVERHOURS_LABELS) : {};
  var schedule = Phase2_DriverHours_scanSchedule_(overviewValues);
  var hintYear = Number(String(TruckSchedule_normalizeDate_(c.startDate, new Date().getFullYear()) || '').slice(0, 4)) || new Date().getFullYear();
  var notes = [];

  var setupDate = '';
  try { setupDate = (Checklist_withSetupDates([c])[0] || {}).setupDate || ''; } catch (e) { setupDate = ''; }
  var range = TruckSchedule_computeRange_(c.startDate, c.endDate, setupDate || overview.setupDate);
  var loadDate = range ? range.setupDate : '';
  var teardownDate = TruckSchedule_normalizeDate_(overview.teardownDate, hintYear) || TruckSchedule_normalizeDate_(c.endDate, hintYear) || (range ? range.to : '');

  var setupStart = Phase2_DriverHours_parseTime_(labeled.setupStart);
  if (setupStart == null) { setupStart = Phase2_DriverHours_parseTime_(overview.firstDayWorkTime); if (setupStart != null) notes.push('設営開始は概要「初日施工時間」の開始側を使用'); }
  if (setupStart == null) setupStart = Phase2_DriverHours_parseTime_(overview.setupDate);
  if (setupStart == null && schedule.setupStart != null) { setupStart = schedule.setupStart; notes.push('設営開始は概要「■会期スケジュール」の設営開始を使用'); }
  var teardownStart = Phase2_DriverHours_parseTime_(labeled.teardownStart);
  if (teardownStart == null) teardownStart = Phase2_DriverHours_parseTime_(overview.teardownDate);
  if (teardownStart == null && schedule.teardownStart != null) { teardownStart = schedule.teardownStart; notes.push('撤去開始は概要「■会期スケジュール」の撤収行を使用'); }
  var lastDayEnd = Phase2_DriverHours_parseTime_(labeled.lastDayEnd);
  if (lastDayEnd == null && labeled.eventHours) {
    var hours = Phase2_DriverHours_allTimes_(labeled.eventHours);
    if (hours.length >= 2) lastDayEnd = hours[hours.length - 1];
  }
  if (lastDayEnd == null && schedule.lastDayEnd != null) { lastDayEnd = schedule.lastDayEnd; notes.push('最終日終了は概要「■会期スケジュール」の最後の展示終了を使用'); }
  var teardownDone = schedule.teardownDone;
  var exitDeadline = Phase2_DriverHours_parseTime_(labeled.exitDeadline);
  var venue = String(overview.venueAddress || '').trim() || String(overview.venueName || '').trim() || String(c.venue || '').trim();
  return {
    dates: { load_in: loadDate, teardown: teardownDate },
    base: { setupStart: setupStart, teardownStart: teardownStart, lastDayEnd: lastDayEnd, teardownDone: teardownDone, exitDeadline: exitDeadline },
    venue: venue, venueIsAddress: !!String(overview.venueAddress || '').trim(), notes: notes,
    pj: read.caseCode || ''
  };
}

/** 指定日・分から Date(スクリプトのタイムゾーン)。過去/不正は null。 */
function _DH_dateAt(ymd, minutes) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(ymd || ''));
  if (!m || typeof minutes !== 'number') return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(minutes / 60), minutes % 60);
}

/**
 * コマンド本体。caseId の実施計画書スタッフシートに、搬入・撤去ドライバーの入時間/出時間を仮記入する(空欄だけ)。
 */
function Phase2_DriverHours_fill(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  if (!c.zissiId) throw new Error('実施計画書(zissi)が登録されていません: ' + caseId);
  const zissi = SpreadsheetApp.openById(c.zissiId);
  const sheet = StaffDrivers_staffSheet_(zissi);
  if (!sheet) {
    return { panelResult: 'スタッフシートが見つかりません（実施計画書に「スタッフ」シートがありません）', panelStatus: '⚠ スタッフシートなし' };
  }
  const link = { staffSheetUrl: PanelLinks_sheetUrl(zissi, sheet), staffSheetName: '実施計画書「' + sheet.getName() + '」' };
  const layout = Phase2_DriverHours_layout_(sheet.getDataRange().getDisplayValues());
  if (!layout.found) {
    return Object.assign({ panelResult: 'スタッフシートの見出し(主な業務・名前・連絡先)を検出できませんでした', panelStatus: '⚠ 一部未記入' }, link);
  }
  const target = layout.driverRows.filter(function (d) {
    return StaffDrivers_unassignedReason(d.name) !== '不要' && !Phase2_DriverHours_roleLegs_(d.role).skip;
  });
  if (!target.length) {
    return Object.assign({ panelResult: 'ドライバー行がありません（宅配搬入などの場合は計算しません）。記入なし', panelStatus: '✅ 完了' }, link);
  }

  const inputs = Phase2_DriverHours_gatherInputs_(c);
  const needLoad = target.some(function (d) { return Phase2_DriverHours_roleLegs_(d.role).legs.indexOf('load_in') >= 0; });
  const needTeardown = target.some(function (d) { return Phase2_DriverHours_roleLegs_(d.role).legs.indexOf('teardown') >= 0; });
  const mapErrors = [];
  const base = Object.assign({}, inputs.base, { travelMin: null, returnMin: null });
  if (!inputs.venue) {
    mapErrors.push('会場住所が取れないため移動時間を計算できません');
  } else {
    // 到着が早朝・夜間でも交通状況を見られるよう、出発は「到着の約90分前」を目安に指定する。
    const arriveLoad = typeof base.setupStart === 'number' ? base.setupStart - DRIVERHOURS_ARRIVE_BEFORE_SETUP_MIN : null;
    const travelAt = needLoad && arriveLoad != null ? _DH_dateAt(inputs.dates.load_in, Math.max(0, arriveLoad - 90))
      : (typeof base.teardownStart === 'number' || typeof base.lastDayEnd === 'number') ? _DH_dateAt(inputs.dates.teardown, Math.max(0, (typeof base.teardownStart === 'number' ? base.teardownStart : base.lastDayEnd))) : null;
    const to = Phase2_DriverHours_travelMinutes_(DRIVERHOURS_WAREHOUSE_ADDRESS, inputs.venue, travelAt);
    if (to.minutes == null) mapErrors.push('倉庫→会場の移動時間を取得できません: ' + to.error); else base.travelMin = to.minutes;
    if (needTeardown && typeof base.lastDayEnd === 'number') {
      const backAt = _DH_dateAt(inputs.dates.teardown, Math.min(1439, base.lastDayEnd + DRIVERHOURS_TEARDOWN_DONE_MIN));
      const from = Phase2_DriverHours_travelMinutes_(inputs.venue, DRIVERHOURS_WAREHOUSE_ADDRESS, backAt);
      if (from.minutes == null) mapErrors.push('会場→倉庫の移動時間を取得できません: ' + from.error); else base.returnMin = from.minutes;
    }
  }
  const plan = Phase2_DriverHours_plan_(layout, { dates: inputs.dates, base: base, bufferMin: DRIVERHOURS_BUFFER_MIN });

  // 書込み(空欄のみ)。セルごとに根拠メモを残す。
  let written = 0;
  plan.writes.forEach(function (w) {
    const cell = sheet.getRange(w.row, w.col);
    if (String(cell.getDisplayValue() || '').trim()) { plan.unchanged++; return; } // 直前に誰かが書いた場合は触らない
    cell.setValue(w.value);
    const prevNote = cell.getNote();
    cell.setNote((prevNote ? prevNote + '\n' : '') + w.note);
    written++;
  });
  SpreadsheetApp.flush();
  // read-back: 書いたつもりのセルが実際に埋まっているか
  let verified = 0;
  plan.writes.forEach(function (w) { if (String(sheet.getRange(w.row, w.col).getDisplayValue() || '').trim()) verified++; });

  const reasons = mapErrors.concat(plan.unwritten.map(function (u) { return u.label + ' ' + u.leg + ': ' + u.reason; }));
  const uniqueReasons = reasons.filter(function (r, i) { return reasons.indexOf(r) === i; });
  if (uniqueReasons.length) {
    try {
      ConfirmationSheet_appendItems(caseId, uniqueReasons.slice(0, 8).map(function (r) {
        return { category: '[ドライバー] 勤務時間', content: 'スタッフシートのドライバー入時間/出時間を仮記入できなかった項目: ' + r };
      }), 2);
    } catch (e) { console.warn('確認事項への追記に失敗: ' + e); }
  }
  const unwrittenCount = plan.unwritten.length;
  const panelResult = 'ドライバー' + plan.drivers + '名・' + verified + 'セル記入／記入済みで変更なし' + plan.unchanged + 'セル／未記入' + unwrittenCount + 'セル' +
    (uniqueReasons.length ? '(' + uniqueReasons.slice(0, 2).join('、') + (uniqueReasons.length > 2 ? ' ほか' : '') + ')' : '');
  return Object.assign({
    panelResult: panelResult,
    panelStatus: (uniqueReasons.length || verified !== written) ? '⚠ 一部未記入' : '✅ 完了',
    written: written, verified: verified, unchanged: plan.unchanged, unwritten: plan.unwritten, mapErrors: mapErrors,
    travelMin: base.travelMin, returnMin: base.returnMin, venue: inputs.venue, inputNotes: inputs.notes
  }, link);
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  Phase2_DriverHours_compute_: Phase2_DriverHours_compute_,
  Phase2_DriverHours_parseTime_: Phase2_DriverHours_parseTime_,
  Phase2_DriverHours_allTimes_: Phase2_DriverHours_allTimes_,
  Phase2_DriverHours_fmtTime_: Phase2_DriverHours_fmtTime_,
  Phase2_DriverHours_roleLegs_: Phase2_DriverHours_roleLegs_,
  Phase2_DriverHours_blockKey_: Phase2_DriverHours_blockKey_,
  Phase2_DriverHours_scanLabels_: Phase2_DriverHours_scanLabels_,
  Phase2_DriverHours_layout_: Phase2_DriverHours_layout_,
  Phase2_DriverHours_plan_: Phase2_DriverHours_plan_,
  DRIVERHOURS_LABELS: DRIVERHOURS_LABELS
};
