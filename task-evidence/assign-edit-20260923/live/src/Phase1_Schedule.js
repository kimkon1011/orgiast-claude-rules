/**
 * Phase1: 全体スケジュール 初版 を生成（schedule(4ヵ月) シート貼り付け方式）。
 *
 * 流れ:
 *  1) Phase1_Estimate が作成した実施計画書を探す
 *  2) パーツマスタの「schedule（4ヵ月）」シート (gid=1089324704) を実施計画書にコピー
 *     既に「スケジュール」シートがある場合はスキップ
 *  3) Claude にマニュアル + 案件情報を渡してマイルストーン JSON 生成
 *  4) **コピーしたスケジュールシートには直接書かない**（数式・体裁を壊さないため）
 *     代わりに別シート「Claude_マイルストーン提案」を作って書き込み、user 側で参照
 *  5) 確認事項を確認シートに積む
 *
 * NOTE:
 *  - 4ヵ月横長テンプレの正確なセル位置（タスク列・日付列）が判別困難なため、
 *    今は提案シート方式。テンプレ構造が判明したら直接書き込みに切替予定。
 */

const SCHEDULE_SOURCE_SS_ID = '1_zbmz8LReBsLRynQ7oIxdyXEwzw7mMnnbULsQcAFfio';
const SCHEDULE_SOURCE_GID = 1089324704; // schedule（4ヵ月）
const SCHEDULE_TARGET_NAME = 'スケジュール';
const SCHEDULE_PROPOSAL_NAME = 'Claude_マイルストーン提案';

function Phase1_Schedule_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 1) 実施計画書を探す
  const zissiSs = _Schedule_findExistingZissi(c);
  if (!zissiSs) {
    throw new Error('実施計画書が見つかりません。先に ② 見積 初版 を生成 を実行してください。');
  }

  // 2) schedule（4ヵ月）シートを実施計画書にコピー（未存在時のみ）
  let scheduleSheet = zissiSs.getSheetByName(SCHEDULE_TARGET_NAME);
  let copiedThisRun = false;
  if (!scheduleSheet) {
    const sourceSs = SpreadsheetApp.openById(SCHEDULE_SOURCE_SS_ID);
    const sourceSheet = sourceSs.getSheets().find(function (s) {
      return s.getSheetId() === SCHEDULE_SOURCE_GID;
    });
    if (!sourceSheet) {
      throw new Error('パーツマスタに schedule(4ヵ月) シート (gid=' + SCHEDULE_SOURCE_GID + ') が見つかりません');
    }
    scheduleSheet = sourceSheet.copyTo(zissiSs);
    scheduleSheet.setName(SCHEDULE_TARGET_NAME);
    copiedThisRun = true;
  }

  // 2.5) summary シート provisioning (スケジュール!#REF! の解消)
  //      スケジュール sheet の数式は =summary!D5(社名) / =summary!D13(案件名) / =summary!D19(開催日) を参照
  const fillResult = _Schedule_provisionSummarySheet(zissiSs, c);

  // 2.52) row 1 / row 6 ヘッダーを復元（コピー構造とテンプレ構造の両方に対応）
  //       過去の壊れた forceRecalc 実装で label が消えたシートにも対応するため、
  //       label/formula を毎回 set。merge 構造が異なる 2 系統に同時対応:
  //       - 現行コピー row 1: N1=開催日, R1=date, X1=内容, AB1=case, BF1=作成日, BJ1=今日, BT1=case
  //       - テンプレ系 row 1: S1=開催日, W1=date, AC1=内容, AG1=case, BK1=作成日, BO1=今日
  //       - 現行コピー row 6: A6/W6/AS6/BO6=日付, F6/AB6/AX6/BT6=内容
  //       - テンプレ系 row 6: A6/S6/AK6/BC6=日付, F6/X6/AP6/BH6=内容
  //       merge top-left でないセルへの書き込みは無視されるので両系統に投げて害なし
  try {
    // row 1
    scheduleSheet.getRange('A1').setValue('　■制作スケジュール');
    scheduleSheet.getRange('N1').setValue('開催日');
    scheduleSheet.getRange('S1').setValue('開催日');
    scheduleSheet.getRange('X1').setValue('内容');
    scheduleSheet.getRange('AC1').setValue('内容');
    scheduleSheet.getRange('BF1').setValue('作成日');
    scheduleSheet.getRange('BK1').setValue('作成日');
    scheduleSheet.getRange('BJ1').setFormula('=TODAY()');
    scheduleSheet.getRange('BO1').setFormula('=TODAY()');
    scheduleSheet.getRange('BT1').setFormula('=summary!D5&"様 "&summary!D13');
    // row 1 の日付セルを yyyy/MM/dd 表示に
    ['R1', 'W1', 'BJ1', 'BO1'].forEach(function (a) {
      try { scheduleSheet.getRange(a).setNumberFormat('yyyy/MM/dd'); } catch (e) {}
    });
    // row 6 (日付/内容ヘッダー — コピー版 + テンプレ版の両系統)
    ['A6', 'W6', 'AS6', 'BO6', 'S6', 'AK6', 'BC6'].forEach(function (a) {
      try { scheduleSheet.getRange(a).setValue('日付'); } catch (e) {}
    });
    ['F6', 'AB6', 'AX6', 'BT6', 'X6', 'AP6', 'BH6'].forEach(function (a) {
      try { scheduleSheet.getRange(a).setValue('内容'); } catch (e) {}
    });
  } catch (e) { /* skip */ }

  // 2.55) スケジュールシートの数式を強制再評価（#REF! キャッシュ解消）
  //       数式セルだけ setFormula で書き戻す（非数式セルのテキストラベルは保持）
  _Schedule_forceRecalcFormulas(scheduleSheet);

  // 2.6) 診断: スケジュールシートの row 1-10 構造を Claude_診断 Doc に dump
  _Schedule_dumpDiagnostic(zissiSs, scheduleSheet, fillResult);

  // 3) Claude でマイルストーン生成
  const manualPages = ManualLoader_findPages([
    'スケジュールシートの作成（全体スケジュール）'
  ]);
  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件の全体スケジュール（初版）を、出展開始日から逆算して作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '## 出力形式（厳守・前後の説明文不要）',
    '{',
    '  "milestones": [',
    '    {"task": "...", "owner": "...", "dueDate": "yyyy/MM/dd", "note": "..."}',
    '  ],',
    '  "confirmations": [',
    '    {"category": "...", "content": "..."}',
    '  ]',
    '}',
    '',
    '注意:',
    '- 出展期間が未確定の場合は milestones を空にして confirmations に「出展期間の確定」を入れる。',
    '- owner は社内の確定情報がなければ空文字にすること（人名を捏造しない）。',
    '- マニュアルが定める標準工程を網羅すること。',
    '- マイルストーンは出展日から逆算した期日 (dueDate) を必ず入れる。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 4000
  });

  const parsed = _Phase1_parseJson(res.text);
  const milestones = parsed.milestones || [];

  // 3.5) マイルストーンをスケジュール（4ヵ月）カレンダーの該当日 内容セルに書き込み
  const calendarWriteLog = _Schedule_writeMilestonesToCalendar(scheduleSheet, milestones);

  // 4) Claude_マイルストーン提案 シートに書き込み（毎回上書き）
  let proposalSheet = zissiSs.getSheetByName(SCHEDULE_PROPOSAL_NAME);
  if (!proposalSheet) {
    proposalSheet = zissiSs.insertSheet(SCHEDULE_PROPOSAL_NAME);
  } else {
    proposalSheet.clear();
  }
  proposalSheet.getRange(1, 1, 1, 4).setValues([['タスク', '担当', '期日', '備考']]);
  proposalSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#cfe2f3');
  proposalSheet.setFrozenRows(1);
  if (milestones.length > 0) {
    const rows = milestones.map(function (m) {
      return [m.task || '', m.owner || '', m.dueDate || '', m.note || ''];
    });
    proposalSheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  proposalSheet.setColumnWidth(1, 320);
  proposalSheet.setColumnWidth(2, 80);
  proposalSheet.setColumnWidth(3, 110);
  proposalSheet.setColumnWidth(4, 400);

  // 5) 確認事項
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    ConfirmationSheet_appendItems(caseId, parsed.confirmations.map(function (x) {
      return Object.assign({}, x, { category: 'スケジュール/' + (x.category || '') });
    }), 1);
  }

  // 案件マスタへの転記は今ファースト版では行わない（user が schedule シートへ手動で反映）
  parsed.confirmations = (parsed.confirmations || []).concat([{
    category: 'スケジュール/反映',
    content: 'Claude_マイルストーン提案シートに ' + milestones.length + ' 件のマイルストーンを生成しました。' +
      'スケジュール（4ヵ月）シートには直接書いていません。提案を見ながら手動で配置してください。'
  }]);

  CaseList_touchUpdatedAt(caseId);

  // gid 付きURL でそれぞれの該当タブに直接開ける形にする
  const scheduleSheetUrl = PanelLinks_sheetUrl(zissiSs, scheduleSheet);
  const proposalSheetUrl = PanelLinks_sheetUrl(zissiSs, proposalSheet);

  MasterWriteBack_recordArtifact(caseId, 'スケジュール', '全体スケジュール 初版 (' + milestones.length + ' マイルストーン)', scheduleSheetUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    scheduleSheetUrl: scheduleSheetUrl,
    proposalSheetUrl: proposalSheetUrl,
    scheduleSheetName: SCHEDULE_TARGET_NAME,
    proposalSheetName: SCHEDULE_PROPOSAL_NAME,
    scheduleCopiedThisRun: copiedThisRun,
    milestoneCount: milestones.length,
    confirmationCount: (parsed.confirmations || []).length,
    fillWrites: fillResult ? fillResult.writes : [],
    fillReason: fillResult ? fillResult.reason : null,
    calendarWrites: calendarWriteLog ? calendarWriteLog.writes : [],
    usage: res.usage
  };
}

// -------- internals --------

function _Schedule_dumpDiagnostic(zissiSs, scheduleSheet, fillResult) {
  // 診断結果を Google Doc に書く (Drive MCP natural-language export が Doc 本文を完全に出力するため)
  const caseFolder = DriveApp.getFolderById(zissiSs.getId()).getParents().next();
  const docName = 'Claude_診断_schedule';
  let doc;
  const it = caseFolder.getFilesByName(docName);
  if (it.hasNext()) {
    const file = it.next();
    doc = DocumentApp.openById(file.getId());
    doc.getBody().clear();
  } else {
    doc = DocumentApp.create(docName);
    DriveApp.getFileById(doc.getId()).moveTo(caseFolder);
  }

  const body = doc.getBody();
  const lines = [];
  lines.push('=== Schedule Diagnostic ===');
  lines.push('timestamp: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'));
  lines.push('scheduleSheet.name: ' + scheduleSheet.getName());
  lines.push('scheduleSheet.gid: ' + String(scheduleSheet.getSheetId()));

  const lastRow = Math.min(scheduleSheet.getLastRow(), 10);
  const lastCol = Math.min(scheduleSheet.getLastColumn(), 50);
  lines.push('scanned.range: 1,1 to ' + lastRow + ',' + lastCol);

  lines.push('');
  lines.push('=== fillWrites (what was written) ===');
  if (fillResult && fillResult.writes && fillResult.writes.length > 0) {
    fillResult.writes.forEach(function (w) {
      lines.push('write: ' + JSON.stringify(w));
    });
  } else {
    lines.push('write: NONE - no label or yellow bg found');
    if (fillResult && fillResult.reason) lines.push('reason: ' + fillResult.reason);
  }

  lines.push('');
  lines.push('=== Unique non-white backgrounds in rows 1-10 ===');
  if (lastRow > 0 && lastCol > 0) {
    const bgs = scheduleSheet.getRange(1, 1, lastRow, lastCol).getBackgrounds();
    const seen = {};
    for (let r = 0; r < bgs.length; r++) {
      for (let cc = 0; cc < bgs[r].length; cc++) {
        const bg = String(bgs[r][cc] || '').toLowerCase();
        if (bg && bg !== '#ffffff' && bg !== '#fff' && bg !== '') {
          if (!seen[bg]) seen[bg] = [];
          seen[bg].push('r' + (r + 1) + 'c' + (cc + 1));
        }
      }
    }
    Object.keys(seen).forEach(function (bg) {
      lines.push('bg ' + bg + ': ' + seen[bg].slice(0, 12).join(',') + (seen[bg].length > 12 ? '...(' + seen[bg].length + ' total)' : ''));
    });
    if (Object.keys(seen).length === 0) {
      lines.push('bg: NONE — all cells in range are white');
    }
  }

  lines.push('');
  lines.push('=== Row 1-5 cells (non-empty only) ===');
  if (lastRow > 0 && lastCol > 0) {
    const vals = scheduleSheet.getRange(1, 1, Math.min(lastRow, 5), lastCol).getValues();
    const fmls = scheduleSheet.getRange(1, 1, Math.min(lastRow, 5), lastCol).getFormulas();
    for (let r = 0; r < vals.length; r++) {
      for (let cc = 0; cc < vals[r].length; cc++) {
        const v = String(vals[r][cc] || '');
        const f = String(fmls[r][cc] || '');
        if (v !== '' || f !== '') {
          lines.push('r' + (r + 1) + 'c' + (cc + 1) + ' val=[' + v.substring(0, 60) + '] formula=[' + f.substring(0, 60) + ']');
        }
      }
    }
  }

  body.setText(lines.join('\n'));
  doc.saveAndClose();
}

function _Schedule_writeMilestonesToCalendar(scheduleSheet, milestones) {
  // 4ヵ月カレンダーの各セクションに、該当日のマイルストーンを書き込む。
  // セクション構造（diagnostic で確認済み）:
  //   Section 1 (Feb): A=日付, B-C=内容, D=曜日
  //   Section 2 (Mar): W=日付, X-Y=内容, Z=曜日
  //   Section 3 (Apr): AS=日付, AT-AU=内容, AV=曜日
  //   Section 4 (May): BO=日付, BP-BQ=内容, BR=曜日
  const writeLog = [];
  if (!milestones || milestones.length === 0) return { writes: writeLog };

  // セクション構造（2026-06-15 read-back 検証で修正）:
  //   日付セルは 5 列 merge (top-left のみが値を持つ) → dateCol は **必ず merge top-left** にする
  //   内容セル開始位置: date+6 (日付セルの merge 終端の次の列)
  //   Section 1: A(date)=1, G(content)=7
  //   Section 2: S(date)=19, Y(content)=25
  //   Section 3: AK(date)=37, AQ(content)=43
  //   Section 4: BC(date)=55, BI(content)=61
  const sections = [
    { dateCol: 1, contentCol: 7 },
    { dateCol: 19, contentCol: 25 },
    { dateCol: 37, contentCol: 43 },
    { dateCol: 55, contentCol: 61 }
  ];

  // 各セクションの日付列を読み取り、日付 → {row, contentCol} の map を作る
  const dateMap = {};
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    let colValues;
    try {
      colValues = scheduleSheet.getRange(7, sec.dateCol, 31, 1).getValues();
    } catch (e) { continue; }
    for (let r = 0; r < colValues.length; r++) {
      const v = colValues[r][0];
      if (v instanceof Date && !isNaN(v.getTime())) {
        const key = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd');
        if (!dateMap[key]) {
          dateMap[key] = { row: 7 + r, contentCol: sec.contentCol };
        }
      }
    }
  }

  // 既存セルをクリア（再生成時の重複防止）
  // 新 content col (7/25/43/61) + 旧 content col (29/51/73, 28/50/72) の両方をクリア
  const allClearCols = [7, 25, 43, 61, 28, 29, 50, 51, 72, 73];
  allClearCols.forEach(function (col) {
    try {
      scheduleSheet.getRange(7, col, 31, 1).clearContent();
    } catch (e) { /* skip */ }
  });

  // 同じ日付に複数マイルストーンが来たら改行で結合
  const cellBuffer = {}; // key: row+col → text

  milestones.forEach(function (m) {
    if (!m.dueDate) return;
    const raw = String(m.dueDate).replace(/-/g, '/').trim();
    const parts = raw.split('/');
    let normalized;
    if (parts.length === 3) {
      normalized = parts[0] + '/' + ('0' + parts[1]).slice(-2) + '/' + ('0' + parts[2]).slice(-2);
    } else {
      normalized = raw;
    }
    const target = dateMap[normalized];
    if (!target) {
      writeLog.push({ date: m.dueDate, task: m.task, action: 'skipped (date out of calendar range)' });
      return;
    }
    const bufKey = target.row + ',' + target.contentCol;
    cellBuffer[bufKey] = cellBuffer[bufKey] ? cellBuffer[bufKey] + '\n' + m.task : m.task;
    writeLog.push({ date: normalized, row: target.row, col: target.contentCol, task: m.task });
  });

  // バッファをセルに書き込み
  // setValue / setWrap を分離（チェーン中の例外で setValue が巻き戻る可能性回避）
  Object.keys(cellBuffer).forEach(function (k) {
    const parts = k.split(',');
    const row = parseInt(parts[0], 10);
    const col = parseInt(parts[1], 10);
    const range = scheduleSheet.getRange(row, col);
    try {
      range.setValue(cellBuffer[k]);
    } catch (e) {
      writeLog.push({ action: 'setValue ERROR', row: row, col: col, error: e.toString() });
      return;
    }
    try {
      range.setWrap(false);
    } catch (e) {
      writeLog.push({ action: 'setWrap ERROR (value still set)', row: row, col: col, error: e.toString() });
    }
  });

  return { writes: writeLog };
}

function _Schedule_forceRecalcFormulas(sheet) {
  // 数式エラーがキャッシュされている時、参照先が後から正しくなっても再評価されない。
  // 対策: 数式があるセルだけ個別に setFormula で書き戻す → 再評価される。
  // ★setFormulas 一括は NG: 非数式セル（"開催日"等のテキストラベル）に空文字が書かれて消える。
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return;
  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const formulas = range.getFormulas();
  for (let r = 0; r < formulas.length; r++) {
    for (let c = 0; c < formulas[r].length; c++) {
      const f = formulas[r][c];
      if (f) {
        try {
          sheet.getRange(r + 1, c + 1).setFormula(f);
        } catch (e) { /* skip */ }
      }
    }
  }
  SpreadsheetApp.flush();
}

function _Schedule_provisionSummarySheet(zissiSs, caseInfo) {
  // スケジュール (4ヵ月) の数式は同じ workbook 内の `summary` シートを参照する。
  // コピー元にあれば copyTo してから対象セルを上書き。無ければ insertSheet して必要セルだけ埋める。
  const writeLog = [];
  let dt = null;
  if (caseInfo.startDate) {
    if (caseInfo.startDate instanceof Date) {
      dt = caseInfo.startDate;
    } else {
      const str = String(caseInfo.startDate).trim();
      if (str) {
        const parsed = new Date(str.replace(/-/g, '/'));
        if (!isNaN(parsed.getTime())) dt = parsed;
      }
    }
  }

  let summarySheet = zissiSs.getSheetByName('summary');
  if (!summarySheet) {
    try {
      const sourceSs = SpreadsheetApp.openById(SCHEDULE_SOURCE_SS_ID);
      const sourceSummary = sourceSs.getSheetByName('summary');
      if (sourceSummary) {
        summarySheet = sourceSummary.copyTo(zissiSs);
        summarySheet.setName('summary');
        writeLog.push({ action: 'copied summary from source' });
      } else {
        summarySheet = zissiSs.insertSheet('summary');
        writeLog.push({ action: 'created empty summary (source has no summary sheet)' });
      }
    } catch (e) {
      writeLog.push({ action: 'failed to provision summary', error: e.toString() });
      return { writes: writeLog };
    }
  } else {
    writeLog.push({ action: 'summary sheet already exists, reusing' });
  }

  // summary シート: D/I/AV 列に同じ値を書く（テンプレ版 + コピー版 + 右側ヘッダーの三系統が参照）
  //                  D5/I5/AV5 = 社名, D13/I13/AV13 = 案件名, D19/I19/AV19 = 開催日
  try {
    ['D5', 'I5', 'AV5'].forEach(function (a) { summarySheet.getRange(a).setValue(caseInfo.clientName || ''); });
    writeLog.push({ sheet: 'summary', cell: 'D5/I5/AV5', value: caseInfo.clientName || '' });
    ['D13', 'I13', 'AV13'].forEach(function (a) { summarySheet.getRange(a).setValue(caseInfo.caseName || ''); });
    writeLog.push({ sheet: 'summary', cell: 'D13/I13/AV13', value: caseInfo.caseName || '' });
    if (dt) {
      ['D19', 'I19', 'AV19'].forEach(function (a) { summarySheet.getRange(a).setValue(dt); });
      writeLog.push({ sheet: 'summary', cell: 'D19/I19/AV19', value: Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy/MM/dd') });
    } else {
      writeLog.push({ sheet: 'summary', cell: 'D19/I19/AV19', value: '(skipped: no valid startDate)' });
    }
  } catch (e) {
    writeLog.push({ action: 'failed to write summary cells', error: e.toString() });
  }

  // 企画 シート: B30 = 出展日（スケジュールの A7 が =EOMONTH('企画'!B30, -4)+1 で参照する）
  try {
    const kikakuSheet = zissiSs.getSheetByName('企画');
    if (kikakuSheet && dt) {
      kikakuSheet.getRange('B30').setValue(dt);
      writeLog.push({ sheet: '企画', cell: 'B30', value: Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy/MM/dd') });
    } else if (!kikakuSheet) {
      writeLog.push({ sheet: '企画', cell: 'B30', value: '(skipped: 企画 sheet not found)' });
    }
  } catch (e) {
    writeLog.push({ action: 'failed to write 企画 B30', error: e.toString() });
  }

  return { writes: writeLog };
}

function _Schedule_findExistingZissi(caseInfo) {
  // 最優先: 案件一覧 K列 に保存された実施計画書ID（Phase1_Estimate が書き込む）
  if (caseInfo.zissiId) {
    try {
      return SpreadsheetApp.openById(caseInfo.zissiId);
    } catch (e) { /* ID が無効なら次の方法へ */ }
  }

  // フォールバック: 候補フォルダ（legacy プロジェクトフォルダ + My Drive 案件フォルダ）から名前検索
  const candidates = [];
  if (caseInfo.projectFolderId) candidates.push(caseInfo.projectFolderId);
  if (caseInfo.folderId) candidates.push(caseInfo.folderId);

  for (let i = 0; i < candidates.length; i++) {
    try {
      const folder = DriveApp.getFolderById(candidates[i]);
      const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (files.hasNext()) {
        const f = files.next();
        if (f.getName().indexOf('実施計画書') >= 0 && f.getName().indexOf('提出') < 0) {
          return SpreadsheetApp.openById(f.getId());
        }
      }
    } catch (e) { /* 次の候補へ */ }
  }

  // 最終フォールバック: Drive 全体から「<案件名> + 実施計画書」で検索
  try {
    const safeName = String(caseInfo.caseName || '').replace(/"/g, '');
    if (safeName) {
      const query = "title contains '" + safeName + "' and title contains '実施計画書' " +
        "and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
      const it = DriveApp.searchFiles(query);
      while (it.hasNext()) {
        const f = it.next();
        if (f.getName().indexOf('提出') < 0) {
          return SpreadsheetApp.openById(f.getId());
        }
      }
    }
  } catch (e) { /* 検索失敗は null へ */ }

  return null;
}
