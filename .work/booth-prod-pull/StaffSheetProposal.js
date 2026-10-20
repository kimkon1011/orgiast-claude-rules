/**
 * スタッフシート更新案を作る（人数・集合時刻）。
 *
 * 根拠:
 *  - 人数: 「施工時間計算」シートの計算式（面積 A ㎡、k = 14、トラス有無、設営日数から算出）。
 *  - 集合時刻（入時間）:
 *      - 設営初日: 職人・手元 = 会場入場可能E − 30分、ドライバー兼作業員 = E − 90分（会場付近の駐車場に集合し、そこから車輌待機所へ向かう。待機所が早くから埋まるため 2026-10-19 cr 指示で75分→90分）
 *      - 設営2日目: 職人・手元 = E ちょうど、ドライバー兼作業員 = E ちょうど
 *      - 撤収日: 職人・手元 = 撤去開始E − 60分、ドライバー兼作業員 = E − 75分（会場付近の駐車場に集合。撤収のドライバー兼作業員はアルバイト）
 *  - 元のスタッフシートは書き換えずに `copyTo` で複製した別シート「スタッフシート更新案」に記入・行追加を行う。
 */

const STAFF_PROPOSAL_SHEET_NAME = 'スタッフシート更新案';
const STAFF_PROPOSAL_HIGHLIGHT_COLOR = '#fff2cc'; // 薄い黄色

/**
 * 会場に入れる時刻(E)を拾うラベル表。
 *
 * **Phase2_DriverHours の DRIVERHOURS_LABELS をそのまま使う**(別々に持つと、片方だけ直したときに
 * 同じ案件で「ドライバーの勤務時間」と「スタッフの集合時刻」が違う E を使って食い違う)。
 * GAS は全ファイル共有スコープなので、読み込み順に依存しないよう関数で遅延参照する。
 */
function StaffSheetProposal_eLabels_() {
  return DRIVERHOURS_LABELS;
}

/**
 * 施工時間計算シートの式による人数計算（純関数）。
 * @param {number} area 小間面積 A ㎡
 * @param {boolean} truss トラス有無
 * @param {boolean} multiDay 設営が2日以上か
 * @return {{day1Craft:number, day1Helper:number, day1Staff:number, day2Craft:number|null, day2Helper:number|null, day2Staff:number|null, tdCraft:number, tdHelper:number, tdStaff:number}}
 */
function StaffSheetProposal_headcount_(area, truss, multiDay) {
  const A = Number(area);
  if (!isFinite(A) || A <= 0) return null;
  const k = 14;
  const EPS = 1e-9;
  function fl(n) { return Math.floor(n + EPS); }
  function cl(n) { return Math.ceil(n - EPS); }

  if (!truss && multiDay) {
    return {
      day1Craft: fl(1 + A / k / 3),
      day1Helper: fl(1 + A / k / 1.2),
      day1Staff: fl(A / k / 1.2),
      day2Craft: fl(1 + A / k / 50),
      day2Helper: 0,
      day2Staff: 0,
      tdCraft: cl(fl(1 + A / k / 3) / 2),
      tdHelper: fl(1 + A / k / 2),
      tdStaff: fl(1 + A / k / 2)
    };
  } else if (truss && multiDay) {
    const d1Helper = fl(2 + A / k / 3);
    return {
      day1Craft: fl(1 + A / k / 2),
      day1Helper: d1Helper,
      day1Staff: fl(1 + A / k / 1.6),
      day2Craft: fl(1 + A / k / 50),
      day2Helper: 0,
      day2Staff: 0,
      tdCraft: fl(1 + A / k / 2.5),
      tdHelper: d1Helper,
      tdStaff: fl(1 + A / k / 2)
    };
  } else if (!truss && !multiDay) {
    const d1Craft = fl(1 + A / k / 3);
    return {
      day1Craft: d1Craft,
      day1Helper: fl(1 + A / k / 1.2),
      day1Staff: fl(A / k / 1.2),
      day2Craft: null,
      day2Helper: null,
      day2Staff: null,
      tdCraft: cl(d1Craft / 2),
      tdHelper: fl(1 + A / k / 2),
      tdStaff: fl(1 + A / k / 2)
    };
  } else {
    // truss && !multiDay
    const d1Helper = fl(2 + A / k / 3) * 2;
    return {
      day1Craft: fl(1 + A / k / 2) * 2,
      day1Helper: d1Helper,
      day1Staff: fl(1 + A / k / 1.6) * 2,
      day2Craft: null,
      day2Helper: null,
      day2Staff: null,
      tdCraft: fl(1 + A / k / 2.5),
      tdHelper: d1Helper,
      tdStaff: fl(1 + A / k / 1.2)
    };
  }
}

/**
 * 実施計画書のシート群からトラス有無を判定する（純関数）。
 * @param {Array<{sheetName:string, values:Array<Array<any>>}>} sheetsData
 * @return {{hasTruss:boolean, sourceNote:string, matched:boolean}}
 */
function StaffSheetProposal_detectTrussFromSheets_(sheetsData) {
  let foundTruss = false;
  let foundNoTruss = false;
  let firstTrussCell = '';
  let firstNoTrussCell = '';

  for (let s = 0; s < (sheetsData || []).length; s++) {
    const item = sheetsData[s];
    const name = String(item.sheetName || '');
    if (name.indexOf('スタッフ') >= 0 || name.indexOf('更新案') >= 0) continue;
    const values = item.values || [];
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const text = String(values[r][c] == null ? '' : values[r][c]).normalize('NFKC');
        if (/トラス(?:無|なし|不要)/.test(text)) {
          if (!foundNoTruss) {
            foundNoTruss = true;
            firstNoTrussCell = name + '!R' + (r + 1) + 'C' + (c + 1) + ' (' + text.slice(0, 30) + ')';
          }
        } else if (/トラス/.test(text)) {
          if (!foundTruss) {
            foundTruss = true;
            firstTrussCell = name + '!R' + (r + 1) + 'C' + (c + 1) + ' (' + text.slice(0, 30) + ')';
          }
        }
      }
    }
  }

  if (foundTruss) {
    return { hasTruss: true, sourceNote: 'トラスあり（' + firstTrussCell + '）', matched: true };
  }
  if (foundNoTruss) {
    return { hasTruss: false, sourceNote: 'トラスなし指定（' + firstNoTrussCell + '）', matched: true };
  }
  return { hasTruss: false, sourceNote: '判定不能のためトラス無で計算', matched: false };
}

/**
 * スタッフシートの日付ブロックを設営初日・2日目以降・撤収日に分類する（純関数）。
 * @param {Array<{date:string, inCol:number, outCol:number}>} dateBlocks
 * @param {string|Date} startDate 案件会期開始
 * @param {string|Date} endDate 案件会期終了
 * @param {string|Date} teardownDate 概要またはrangeの撤去日
 * @param {number} hintYear
 * @return {{setupDays:Array<object>, teardownDays:Array<object>, otherDays:Array<object>, multiDay:boolean, setupFirstDay:object|null, setupDay2:object|null, teardownDay:object|null}}
 */
function StaffSheetProposal_classifyDates_(dateBlocks, startDate, endDate, teardownDate, hintYear) {
  const norm = TruckSchedule_normalizeDate_;
  const startYmd = norm(startDate, hintYear);
  const endYmd = norm(endDate, hintYear);
  const tdYmd = norm(teardownDate, hintYear) || endYmd;

  const setupDays = [];
  const teardownDays = [];
  const otherDays = [];

  (dateBlocks || []).forEach(function (b) {
    const ymd = norm(b.date, hintYear);
    if (!ymd) {
      otherDays.push(Object.assign({}, b, { ymd: '' }));
      return;
    }
    const blockWithYmd = Object.assign({}, b, { ymd: ymd });
    if (startYmd && ymd < startYmd) {
      setupDays.push(blockWithYmd);
    } else if ((tdYmd && ymd === tdYmd) || (endYmd && ymd === endYmd)) {
      teardownDays.push(blockWithYmd);
    } else {
      otherDays.push(blockWithYmd);
    }
  });

  // 日付順にソート
  setupDays.sort(function (a, b) { return a.ymd.localeCompare(b.ymd); });
  teardownDays.sort(function (a, b) { return a.ymd.localeCompare(b.ymd); });

  const multiDay = setupDays.length >= 2;
  const setupFirstDay = setupDays.length > 0 ? setupDays[0] : null;
  const setupDay2 = setupDays.length > 1 ? setupDays[1] : null;
  const teardownDay = teardownDays.length > 0 ? teardownDays[0] : null;

  return {
    setupDays: setupDays,
    teardownDays: teardownDays,
    otherDays: otherDays,
    multiDay: multiDay,
    setupFirstDay: setupFirstDay,
    setupDay2: setupDay2,
    teardownDay: teardownDay
  };
}

/**
 * 概要シートの走査結果と概要オブジェクトから各日の会場に入れる時刻（E）を求める（純関数）。
 * @param {object} labeled Phase2_DriverHours_scanLabels_ の結果
 * @param {object} overview CaseApi_readOverview の overview
 * @return {{day1:{minutes:number|null, timeText:string, source:string}, day2:{minutes:number|null, timeText:string, source:string, assumed:boolean}, teardown:{minutes:number|null, timeText:string, source:string, substituted:boolean}, confirmations:string[]}}
 */
function StaffSheetProposal_resolveEntranceTimes_(labeled, overview) {
  const parse = Phase2_DriverHours_parseTime_;
  const all = Phase2_DriverHours_allTimes_;
  const fmt = Phase2_DriverHours_fmtTime_;
  const confirmations = [];

  // 設営初日
  let day1Min = parse(labeled.setupStart);
  let day1Src = labeled.setupStart ? '概要ラベル「' + labeled.setupStart + '」' : '';
  if (day1Min == null && overview.firstDayWorkTime) {
    day1Min = parse(overview.firstDayWorkTime);
    if (day1Min != null) day1Src = '概要「初日施工時間」の開始側';
  }
  if (day1Min == null) {
    confirmations.push('設営初日の会場入場可能時刻が概要から取れませんでした');
  }

  // 設営2日目
  let day2Min = parse(labeled.setupDay2Start);
  let day2Src = labeled.setupDay2Start ? '概要ラベル「' + labeled.setupDay2Start + '」' : '';
  let day2Assumed = false;
  if (day2Min == null && day1Min != null) {
    day2Min = day1Min;
    day2Src = '設営初日と同じ時刻を仮採用';
    day2Assumed = true;
    confirmations.push('設営2日目の入場可能時刻が概要に無いため初日と同じ時刻で仮記入');
  } else if (day2Min == null) {
    confirmations.push('設営2日目の会場入場可能時刻が概要から取れませんでした');
  }

  // 撤収日
  let tdMin = parse(labeled.teardownStart);
  let tdSrc = labeled.teardownStart ? '概要ラベル「' + labeled.teardownStart + '」' : '';
  let tdSubstituted = false;
  if (tdMin == null) {
    tdMin = parse(overview.teardownDate);
    if (tdMin != null) tdSrc = '概要「撤去日」の時刻';
  }
  if (tdMin == null) {
    tdMin = parse(labeled.lastDayEnd);
    if (tdMin != null) {
      tdSrc = '概要ラベル「' + labeled.lastDayEnd + '」（最終日終了代用）';
      tdSubstituted = true;
      confirmations.push('撤収開始時刻が概要に無いため最終日終了時刻で代用して仮記入');
    }
  }
  if (tdMin == null && labeled.eventHours) {
    const hours = all(labeled.eventHours);
    if (hours.length >= 2) {
      tdMin = hours[hours.length - 1];
      tdSrc = '概要「開催時間」の終了側（最終日終了代用）';
      tdSubstituted = true;
      confirmations.push('撤収開始時刻が概要に無いため開催時間の終了時刻で代用して仮記入');
    }
  }
  if (tdMin == null) {
    confirmations.push('撤収日の撤去開始時刻・最終日終了時刻が概要から取れませんでした');
  }

  return {
    day1: { minutes: day1Min, timeText: fmt(day1Min) || '', source: day1Src },
    day2: { minutes: day2Min, timeText: fmt(day2Min) || '', source: day2Src, assumed: day2Assumed },
    teardown: { minutes: tdMin, timeText: fmt(tdMin) || '', source: tdSrc, substituted: tdSubstituted },
    confirmations: confirmations
  };
}

/**
 * 役割・日ごとの集合時刻（入時間）とメモを計算する（純関数）。
 * @param {string} roleKey 'craft'|'helper'|'staff'
 * @param {string} dayType 'day1'|'day2'|'teardown'
 * @param {object} entranceTimes StaffSheetProposal_resolveEntranceTimes_ の結果
 * @return {{time:string, note:string, missing:string}}
 */
function StaffSheetProposal_gatherTimeForRole_(roleKey, dayType, entranceTimes) {
  const fmt = Phase2_DriverHours_fmtTime_;
  const eObj = dayType === 'day1' ? entranceTimes.day1 : dayType === 'day2' ? entranceTimes.day2 : entranceTimes.teardown;
  const eMin = eObj ? eObj.minutes : null;

  if (eMin == null) {
    const dayLabel = dayType === 'day1' ? '設営初日' : dayType === 'day2' ? '設営2日目' : '撤収日';
    return { time: '', note: '', missing: dayLabel + 'の会場入場可能時刻が取れないため入時間は未記入' };
  }

  let gatherMin = null;
  let noteDesc = '';

  if (dayType === 'day1') {
    if (roleKey === 'staff') {
      gatherMin = eMin - 90;
      noteDesc = '設営初日 会場入場可能 ' + fmt(eMin) + ' の90分前・会場付近の駐車場に集合し、そこから車輌待機所へ向かう';
    } else {
      gatherMin = eMin - 30;
      noteDesc = '設営初日 会場入場可能 ' + fmt(eMin) + ' の30分前';
    }
  } else if (dayType === 'day2') {
    gatherMin = eMin;
    noteDesc = '設営2日目 会場入場可能 ' + fmt(eMin) + ' ちょうど' + (eObj.assumed ? '（初日と同じ時刻で仮設定）' : '');
  } else {
    // teardown
    if (roleKey === 'staff') {
      gatherMin = eMin - 75;
      noteDesc = '撤収日 撤去開始 ' + fmt(eMin) + (eObj.substituted ? '(代用)' : '') + ' の75分前・会場付近の駐車場に集合（撤収のドライバー兼作業員はアルバイト）';
    } else {
      gatherMin = eMin - 60;
      noteDesc = '撤収日 撤去開始 ' + fmt(eMin) + (eObj.substituted ? '(代用)' : '') + ' の60分前';
    }
  }

  const timeStr = fmt(gatherMin);
  if (!timeStr) {
    return { time: '', note: '', missing: '集合時刻が日付をまたぐ計算になるため要手動確認（' + noteDesc + '）' };
  }
  return { time: timeStr, note: noteDesc, missing: '' };
}

/**
 * 主な業務の文字列から役割キーを判定する（純関数）。
 * @param {string} roleText
 * @return {'craft'|'helper'|'staff'|'other'}
 */
function StaffSheetProposal_classifyRole_(roleText) {
  const text = String(roleText || '').normalize('NFKC');
  if (DRIVERHOURS_NOT_DRIVER_ROLE.test(text)) return 'other';
  if (/職人/.test(text)) return 'craft';
  if (/手元/.test(text)) return 'helper';
  if (/ドライバー|運転|ｵｰｼﾞｬｽﾄ(ﾊﾞｲﾄ|ｱﾙﾊﾞｲﾄ)|オージャスト.*(バイト|アルバイト)|アルバイト|バイト/.test(text)) return 'staff';
  return 'other';
}

/**
 * スタッフシート更新案の編集計画を作成する（純関数）。
 * @param {object} layout Phase2_DriverHours_layout_ の結果（全行走査したもの）
 * @param {object} headcount StaffSheetProposal_headcount_ の結果
 * @param {object} entranceTimes StaffSheetProposal_resolveEntranceTimes_ の結果
 * @param {object} dateClass StaffSheetProposal_classifyDates_ の結果
 * @return {object}
 */
function StaffSheetProposal_buildPlan_(layout, headcount, entranceTimes, dateClass) {
  const cols = layout.cols || { role: 0, name: 1 };
  const dataStart = layout.dataStartIndex;

  // 既存データ行を役割ごとに分類
  const roles = {
    craft: { name: '職人', rows: [] },
    helper: { name: '手元', rows: [] },
    staff: { name: 'ドライバー兼作業員', rows: [] }
  };
  const otherRows = [];
  const skippedRows = [];

  const rawRows = layout.rawRows || [];
  rawRows.forEach(function (row, idx) {
    const rowNum = dataStart + 1 + idx;
    const roleText = String(row[cols.role] || '').trim();
    const nameText = String(row[cols.name] == null ? '' : row[cols.name]).trim();
    if (!roleText || /^(?:\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)$/.test(roleText)) return;
    if (StaffDrivers_unassignedReason(nameText) === '不要') {
      skippedRows.push({ rowNumber: rowNum, role: roleText, name: nameText, reason: '不要' });
      return;
    }
    const rKey = StaffSheetProposal_classifyRole_(roleText);
    if (rKey === 'craft' || rKey === 'helper' || rKey === 'staff') {
      roles[rKey].rows.push({ rowNumber: rowNum, role: roleText, name: nameText, cells: row, index: idx });
    } else {
      otherRows.push({ rowNumber: rowNum, role: roleText, name: nameText, cells: row, index: idx });
    }
  });

  // 各日ごとの必要人数
  const counts = {
    craft: {
      day1: headcount ? headcount.day1Craft : 0,
      day2: (headcount && dateClass.multiDay) ? headcount.day2Craft : 0,
      teardown: headcount ? headcount.tdCraft : 0
    },
    helper: {
      day1: headcount ? headcount.day1Helper : 0,
      day2: (headcount && dateClass.multiDay) ? headcount.day2Helper : 0,
      teardown: headcount ? headcount.tdHelper : 0
    },
    staff: {
      day1: headcount ? headcount.day1Staff : 0,
      day2: (headcount && dateClass.multiDay) ? headcount.day2Staff : 0,
      teardown: headcount ? headcount.tdStaff : 0
    }
  };

  // 役割ごとの最大必要行数
  const maxNeeded = {
    craft: Math.max(counts.craft.day1, counts.craft.day2, counts.craft.teardown),
    helper: Math.max(counts.helper.day1, counts.helper.day2, counts.helper.teardown),
    staff: Math.max(counts.staff.day1, counts.staff.day2, counts.staff.teardown)
  };

  // 不足行の挿入計画（挿入位置の算出）
  // 役割ごとの最後の行の直後、無ければデータ最終行の後
  const insertPlans = []; // { roleKey, roleLabel, insertAfterRowNum, count }
  let lastDataRowNum = dataStart + rawRows.length;
  ['craft', 'helper', 'staff'].forEach(function (rKey) {
    const existingCount = roles[rKey].rows.length;
    const needed = maxNeeded[rKey];
    if (needed > existingCount) {
      const shortage = needed - existingCount;
      let afterRow = -1;
      let copyFromRow = -1;
      if (existingCount > 0) {
        const lastRow = roles[rKey].rows[roles[rKey].rows.length - 1];
        afterRow = lastRow.rowNumber;
        copyFromRow = lastRow.rowNumber;
      } else {
        afterRow = lastDataRowNum;
        copyFromRow = lastDataRowNum;
      }
      insertPlans.push({
        roleKey: rKey,
        // 追加するバイト行は「ドライバー」を含めない名前にする(含めると全日に記入されるドライバー行扱いになる)
        roleLabel: rKey === 'staff' ? 'オージャスト手配アルバイト' : roles[rKey].name,
        afterRowNum: afterRow,
        copyFromRowNum: copyFromRow,
        count: shortage
      });
    }
  });

  // 各日について書込み計画を作る
  // 対象ブロック
  const targetDays = [];
  if (dateClass.setupFirstDay) targetDays.push({ type: 'day1', block: dateClass.setupFirstDay, label: '設営初日' });
  if (dateClass.multiDay && dateClass.setupDay2) targetDays.push({ type: 'day2', block: dateClass.setupDay2, label: '設営2日目' });
  if (dateClass.teardownDay) targetDays.push({ type: 'teardown', block: dateClass.teardownDay, label: '撤収日' });

  const writes = [];
  const unchanged = [];
  const unwritten = [];
  const notes = [];

  // 各役割について、先頭からその日の人数の行に書く
  ['craft', 'helper', 'staff'].forEach(function (rKey) {
    const roleRows = roles[rKey].rows;
    targetDays.forEach(function (day) {
      const neededNum = counts[rKey][day.type];
      const gTime = StaffSheetProposal_gatherTimeForRole_(rKey, day.type, entranceTimes);
      if (gTime.missing) {
        unwritten.push({ role: roles[rKey].name, day: day.label, reason: gTime.missing });
        return;
      }
      const inCol = day.block.inCol;
      if (inCol < 0) {
        unwritten.push({ role: roles[rKey].name, day: day.label, reason: day.label + 'の入時間の列がスタッフシートにありません' });
        return;
      }

      // 記入対象の行。ドライバー行は施工時間計算の人数(小間が小さいとバイト0名)と関係なくトラックを運ぶので、
      // 担当区間(搬入=設営初日 / 撤去=撤収日)の日には必ず書き、その人数をバイト必要数に含める。
      let targets = roleRows.slice(0, neededNum);
      if (rKey === 'staff') {
        const legOfDay = day.type === 'day1' ? 'load_in' : day.type === 'teardown' ? 'teardown' : '';
        const isDriver = function (r) { return /ドライバー|運転/.test(String(r.role).normalize('NFKC')); };
        const drivers = roleRows.filter(function (r) {
          return isDriver(r) && legOfDay && Phase2_DriverHours_roleLegs_(r.role).legs.indexOf(legOfDay) >= 0;
        });
        const others = roleRows.filter(function (r) { return !isDriver(r); });
        targets = drivers.concat(others.slice(0, Math.max(0, neededNum - drivers.length)));
      }
      for (let i = 0; i < targets.length; i++) {
        const rowObj = targets[i];
        const currentVal = String(rowObj.cells[inCol] == null ? '' : rowObj.cells[inCol]).trim();
        if (currentVal) {
          unchanged.push({ row: rowObj.rowNumber, col: inCol + 1, value: currentVal, role: rowObj.role, name: rowObj.name });
        } else {
          writes.push({
            row: rowObj.rowNumber,
            col: inCol + 1,
            value: gTime.time,
            note: 'Claude仮記入 ' + day.block.ymd + ': ' + gTime.note,
            role: rowObj.role,
            isNewRow: false
          });
        }
      }
    });

    if (roleRows.length > maxNeeded[rKey]) {
      notes.push(roles[rKey].name + 'は必要人数（最大' + maxNeeded[rKey] + '名）に対して既存行が' + roleRows.length + '行あり、余剰行があります');
    }
  });

  return {
    roles: roles,
    counts: counts,
    maxNeeded: maxNeeded,
    insertPlans: insertPlans,
    writes: writes,
    unchanged: unchanged,
    unwritten: unwritten,
    notes: notes,
    targetDays: targetDays
  };
}

/**
 * 実施計画書に「スタッフシート更新案」を作成するコマンド本体。
 * @param {string} caseId
 * @return {object}
 */
function StaffSheetProposal_create(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  if (!c.zissiId) throw new Error('実施計画書(zissi)が登録されていません: ' + caseId);

  const zissi = SpreadsheetApp.openById(c.zissiId);
  const srcSheet = StaffDrivers_staffSheet_(zissi);
  if (!srcSheet) {
    return { panelResult: 'スタッフシートが見つかりません（実施計画書に「スタッフ」シートがありません）', panelStatus: '⚠ スタッフシートなし' };
  }

  // 1. 案件情報と概要から基礎情報を収集
  const read = CaseApi_readOverview(c);
  const overview = read.overview || {};
  const overviewSheet = zissi.getSheetByName('概要') || zissi.getSheets().filter(function (s) { return s.getName().indexOf('概要') >= 0; })[0];
  const labeled = overviewSheet ? Phase2_DriverHours_scanLabels_(overviewSheet.getDataRange().getDisplayValues(), StaffSheetProposal_eLabels_()) : {};
  const hintYear = Number(String(TruckSchedule_normalizeDate_(c.startDate, new Date().getFullYear()) || '').slice(0, 4)) || new Date().getFullYear();

  // 面積の取得
  let areaVal = _AssignSheet_boothArea(c.boothSize);
  let areaNote = '';
  if (areaVal === '' && overview.koma) {
    const komaNum = Number(String(overview.koma).replace(/[^\d.]/g, ''));
    if (isFinite(komaNum) && komaNum > 0) {
      areaVal = komaNum * 9;
      areaNote = '概要コマ数(' + komaNum + 'コマ)×9㎡で代用';
    }
  }
  if (areaVal === '') {
    ConfirmationSheet_appendItems(caseId, [{
      category: '[スタッフ] 更新案',
      content: '小間面積が自動取得できず人数を計算できませんでした（小間サイズ・コマ数をご確認ください）'
    }], 2);
    return {
      panelResult: '小間面積が取得できないため人数を計算できませんでした',
      panelStatus: '⚠ 要確認',
      staffProposalSheetUrl: PanelLinks_sheetUrl(zissi, srcSheet),
      staffProposalSheetName: '実施計画書「' + srcSheet.getName() + '」'
    };
  }

  // トラス判定
  const allSheetsData = zissi.getSheets().map(function (s) {
    return { sheetName: s.getName(), values: s.getDataRange().getDisplayValues() };
  });
  const trussResult = StaffSheetProposal_detectTrussFromSheets_(allSheetsData);
  const confirmations = [];
  if (!trussResult.matched) {
    confirmations.push('トラス有無を判定できずトラス無の式で計算');
  }

  // 既存スタッフシートのレイアウトと日付ブロック取得
  const srcValues = srcSheet.getDataRange().getDisplayValues();
  const layout = Phase2_DriverHours_layout_(srcValues);
  if (!layout.found) {
    return {
      panelResult: 'スタッフシートの見出し(主な業務・名前・連絡先)を検出できませんでした',
      panelStatus: '⚠ 一部未記入',
      staffProposalSheetUrl: PanelLinks_sheetUrl(zissi, srcSheet),
      staffProposalSheetName: '実施計画書「' + srcSheet.getName() + '」'
    };
  }
  // rawRows を補強（dataStart 以降の行）
  layout.rawRows = StaffDrivers_blockRows_(srcValues.slice(layout.dataStartIndex));

  // 日付分類（設営日数 multiDay）
  const setupDate = TruckSchedule_computeRange_(c.startDate, c.endDate, overview.setupDate);
  const dateClass = StaffSheetProposal_classifyDates_(
    layout.dateBlocks,
    c.startDate,
    c.endDate,
    overview.teardownDate || (setupDate ? setupDate.to : ''),
    hintYear
  );

  // 人数計算
  const headcount = StaffSheetProposal_headcount_(areaVal, trussResult.hasTruss, dateClass.multiDay);

  // 会場入場可能時刻（E）の解決
  const entranceTimes = StaffSheetProposal_resolveEntranceTimes_(labeled, overview);
  (entranceTimes.confirmations || []).forEach(function (conf) { confirmations.push(conf); });

  // 2. 「スタッフシート更新案」シートを準備（既存があれば削除して複製）
  const existingProposal = zissi.getSheetByName(STAFF_PROPOSAL_SHEET_NAME);
  if (existingProposal) {
    zissi.deleteSheet(existingProposal);
  }
  const propSheet = srcSheet.copyTo(zissi);
  propSheet.setName(STAFF_PROPOSAL_SHEET_NAME);

  // 3. 編集計画の策定
  const plan = StaffSheetProposal_buildPlan_(layout, headcount, entranceTimes, dateClass);

  // 4. 行挿入の実行（下の方の行から挿入して行番号のずれを防ぐ）
  let insertedTotal = 0;
  // 挿入計画を行番号降順にソート
  const sortedInsertPlans = plan.insertPlans.slice().sort(function (a, b) {
    return b.afterRowNum - a.afterRowNum;
  });

  // 行挿入と書式コピー
  sortedInsertPlans.forEach(function (p) {
    const startRow = p.afterRowNum + 1;
    propSheet.insertRowsAfter(p.afterRowNum, p.count);
    insertedTotal += p.count;

    for (let i = 0; i < p.count; i++) {
      const curRow = startRow + i;
      // 書式コピー
      const srcRange = propSheet.getRange(p.copyFromRowNum, 1, 1, propSheet.getLastColumn());
      const dstRange = propSheet.getRange(curRow, 1, 1, propSheet.getLastColumn());
      srcRange.copyTo(dstRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);

      // 主な業務と名前を設定
      propSheet.getRange(curRow, layout.cols.role + 1).setValue(p.roleLabel);
      propSheet.getRange(curRow, layout.cols.name + 1).setValue('未アサイン');
      dstRange.setBackground(STAFF_PROPOSAL_HIGHLIGHT_COLOR);
    }
  });

  // 挿入後、シート全体の表示値を再読込して最新レイアウトを構築
  const updatedValues = propSheet.getDataRange().getDisplayValues();
  const updatedLayout = Phase2_DriverHours_layout_(updatedValues);
  updatedLayout.rawRows = StaffDrivers_blockRows_(updatedValues.slice(updatedLayout.dataStartIndex));

  // 最新レイアウトで再度書込み計画を策定（行番号が確定している状態）
  const finalPlan = StaffSheetProposal_buildPlan_(updatedLayout, headcount, entranceTimes, dateClass);

  // 5. 空欄セルへの集合時刻記入
  let writtenCount = 0;
  finalPlan.writes.forEach(function (w) {
    const cell = propSheet.getRange(w.row, w.col);
    const existing = String(cell.getDisplayValue() || '').trim();
    if (existing) {
      finalPlan.unchanged.push(w);
      return;
    }
    cell.setValue(w.value);
    const prevNote = cell.getNote();
    cell.setNote((prevNote ? prevNote + '\n' : '') + w.note);
    cell.setBackground(STAFF_PROPOSAL_HIGHLIGHT_COLOR);
    writtenCount++;
  });

  // 6. 注記ブロックをシート右側に記入（最終列 + 2列目以降）
  const noteCol = propSheet.getLastColumn() + 2;
  const noteRows = [
    ['【スタッフシート更新案の根拠】', ''],
    ['作成日時', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')],
    ['小間面積', areaVal + ' ㎡' + (areaNote ? ' (' + areaNote + ')' : '')],
    ['トラス判定', (trussResult.hasTruss ? 'トラスあり' : 'トラスなし') + ' ─ ' + trussResult.sourceNote],
    ['設営日数', (dateClass.multiDay ? '2日以上 (multiDay=true)' : '1日のみ (multiDay=false)') + ' / 検出設営日: ' + dateClass.setupDays.map(function (d) { return d.ymd; }).join(', ')],
    ['会場入場可能時刻(E)', ''],
    ['  設営初日 E', entranceTimes.day1.timeText + ' (' + entranceTimes.day1.source + ')'],
    ['  設営2日目 E', (dateClass.multiDay ? entranceTimes.day2.timeText + ' (' + entranceTimes.day2.source + ')' : 'なし')],
    ['  撤収日 E', entranceTimes.teardown.timeText + ' (' + entranceTimes.teardown.source + ')'],
    ['必要人数(施工時間計算)', ''],
    ['  設営初日', '職人 ' + headcount.day1Craft + '名 / 手元 ' + headcount.day1Helper + '名 / ドライバー兼作業員 ' + headcount.day1Staff + '名'],
    ['  設営2日目', (dateClass.multiDay ? '職人 ' + headcount.day2Craft + '名 / 手元 ' + headcount.day2Helper + '名 / ドライバー兼作業員 ' + headcount.day2Staff + '名' : 'なし')],
    ['  撤収日', '職人 ' + headcount.tdCraft + '名 / 手元 ' + headcount.tdHelper + '名 / ドライバー兼作業員 ' + headcount.tdStaff + '名'],
    ['仮定・留意点', 'オージャスト手配アルバイト＝ドライバー兼作業員として計算。出時間は記載していません']
  ];
  if (finalPlan.notes.length) {
    noteRows.push(['余剰・注意', finalPlan.notes.join(' / ')]);
  }

  propSheet.getRange(2, noteCol, noteRows.length, 2).setValues(noteRows);
  propSheet.getRange(2, noteCol, 1, 2).setFontWeight('bold').setBackground('#cfe2f3');

  SpreadsheetApp.flush();

  // 7. read-back 検証
  let verifiedCount = 0;
  finalPlan.writes.forEach(function (w) {
    if (String(propSheet.getRange(w.row, w.col).getDisplayValue() || '').trim()) verifiedCount++;
  });

  // 確認事項の登録
  if (confirmations.length) {
    try {
      ConfirmationSheet_appendItems(caseId, confirmations.slice(0, 8).map(function (msg) {
        return { category: '[スタッフ] 更新案', content: msg };
      }), 2);
    } catch (e) {
      console.warn('確認事項への追記失敗: ' + e);
    }
  }

  // 8. 戻り値と結果文
  const resultParts = [
    '職人' + headcount.day1Craft + '・手元' + headcount.day1Helper + '・ドライバー兼作業員' + headcount.day1Staff + '名（設営初日）',
    '入時間 ' + verifiedCount + 'セル記入',
    '行追加 ' + insertedTotal + '行'
  ];
  if (finalPlan.unwritten.length) {
    resultParts.push('未記入 ' + finalPlan.unwritten.length + '（' + finalPlan.unwritten[0].reason + '）');
  }

  const proposalUrl = PanelLinks_sheetUrl(zissi, propSheet);
  return {
    panelResult: resultParts.join('／'),
    panelStatus: (finalPlan.unwritten.length || verifiedCount !== writtenCount) ? '⚠ 一部未記入' : '✅ 完了',
    staffProposalSheetUrl: proposalUrl,
    staffProposalSheetName: '実施計画書「' + STAFF_PROPOSAL_SHEET_NAME + '」',
    headcount: headcount,
    truss: trussResult.hasTruss,
    multiDay: dateClass.multiDay,
    written: writtenCount,
    verified: verifiedCount,
    insertedRows: insertedTotal,
    unwritten: finalPlan.unwritten
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    StaffSheetProposal_headcount_: StaffSheetProposal_headcount_,
    StaffSheetProposal_detectTrussFromSheets_: StaffSheetProposal_detectTrussFromSheets_,
    StaffSheetProposal_classifyDates_: StaffSheetProposal_classifyDates_,
    StaffSheetProposal_resolveEntranceTimes_: StaffSheetProposal_resolveEntranceTimes_,
    StaffSheetProposal_gatherTimeForRole_: StaffSheetProposal_gatherTimeForRole_,
    StaffSheetProposal_classifyRole_: StaffSheetProposal_classifyRole_,
    StaffSheetProposal_buildPlan_: StaffSheetProposal_buildPlan_,
    StaffSheetProposal_create: StaffSheetProposal_create,
    StaffSheetProposal_eLabels_: StaffSheetProposal_eLabels_,
    STAFF_PROPOSAL_SHEET_NAME: STAFF_PROPOSAL_SHEET_NAME
  };
}
