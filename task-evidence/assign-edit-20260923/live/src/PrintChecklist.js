/**
 * 印刷会社へ渡す印刷物チェックシートを、全案件の実施計画と制作フォルダから漏れ優先で生成する。
 */

const PRINT_CHECKLIST_SS_NAME = '【印刷会社様用】印刷物チェックシート';
const PRINT_CHECKLIST_SS_ID_KEY = 'PRINT_CHECKLIST_SS_ID';
const PRINT_CHECKLIST_CURSOR_KEY = 'PRINT_CHECKLIST_CURSOR';
const PRINT_CHECKLIST_LAST_RUN_DATE_KEY = 'PRINT_CHECKLIST_LAST_RUN_DATE';
// GAS の実行上限は 6 分。ここに 270 秒を入れると、案件走査のあとに来る
// 1000 行超のシート書き込み + 書式設定が入り切らず、結果を書かずに殺される
// (実測: 1巡目 295 秒でギリギリ完走、2巡目は結果なしで死亡)。カーソルは完走時しか
// 進まないので、殺されるとその巡は丸損になる。書き込み分の余裕を残して 180 秒にする。
const PRINT_CHECKLIST_TIME_LIMIT_MS = 180000;
const PRINT_CHECKLIST_MAIN_SHEET = '印刷物リスト';
const PRINT_CHECKLIST_SUMMARY_SHEET = '案件サマリ';
const PRINT_CHECKLIST_DESIGN_SHEET = 'デザインデータ一覧';
const PRINT_CHECKLIST_PAST_SHEET = '過去案件(参考)';
const PRINT_CHECKLIST_EXCLUDED_SHEET = '対象外(除外済)';
const PRINT_CHECKLIST_EXCLUSION_RULE_SHEET = '除外ルール';
const PRINT_CHECKLIST_GUIDE_SHEET = '凡例・使い方';
// 「🐛 不具合・要望」フォーム(GAS Web アプリ)の /exec URL。Admin_setFeedbackRelay の第4引数で入れる。
const PRINT_CHECKLIST_FORM_URL_KEY = 'FEEDBACK_FORM_URL';
const PRINT_CHECKLIST_FORM_APP_NAME = '印刷物チェックシート';
const PRINT_CHECKLIST_TZ = 'Asia/Tokyo';
const PRINT_CHECKLIST_HEADERS = [
  '印刷ID', '状態', '案件ID', 'クライアント名', '案件名', '会期', '会期初日', '印刷締切目安',
  '区分', '品名', 'サイズ', '数量', '仕様・加工', 'デザインデータ', 'データ有無', '発生源',
  '備考', '受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ',
  'AIへの指示', '最終更新', '社内確認(PD)'
];
const PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS = [
  'ルールID', '対象 (この案件のみ|全案件)', '案件ID', '品名パターン', '追加日時', '由来の印刷ID'
];
const PRINT_CHECKLIST_PRESERVED_HEADERS = ['状態', '受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ', 'AIへの指示', '社内確認(PD)'];
const PRINT_CHECKLIST_PD_REVIEW_VALUES = ['未確認', '確認済', '対象外'];
const PRINT_CHECKLIST_PD_REVIEW_COL = 25;
const PRINT_CHECKLIST_PD_CACHE_KEY = 'pcPdReview:v1';
const PRINT_CHECKLIST_PD_ASOF_KEY = 'PRINT_CHECKLIST_PD_ASOF';
const PRINT_CHECKLIST_STATUS_VALUES = ['未入稿', '入稿済', '印刷手配済', '印刷完了', '発送済', '対象外'];
const PRINT_CHECKLIST_DATA_CHECK_VALUES = ['未確認', 'OK', '要修正', 'データ不足'];
const PRINT_CHECKLIST_SUMMARY_HEADERS = [
  '案件ID', 'クライアント', '案件名', '会期', '印刷締切目安', '印刷物件数', 'データあり件数',
  'データなし件数', '未入稿件数', '実施計画書リンク', '制作フォルダリンク', '備考', '棚卸し未確認件数'
];
const PRINT_CHECKLIST_DESIGN_HEADERS = ['案件ID', 'クライアント', '入稿確度(高/中/低)', '直上フォルダ', 'ファイル名', '種別(拡張子)',
  '更新日', '主表とのマッチ(済/未)', 'リンク'];
const PRINT_CHECKLIST_MAX_ITEM_ROWS = 3000;
const PRINT_CHECKLIST_DESIGN_MAX_FILES = 400;
const PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS = 25000;
const PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS = 24 * 60 * 60 * 1000;
const PRINT_CHECKLIST_DESIGN_PROPERTY_MAX_BYTES = 9000;
// 実フォルダ名は「03ネガチェック・打合せ資料」「見積り（社外見積もり）」のように後ろが続くので前方一致で判定する。
// 完全一致にすると除外が効かず、走査上限(400件)をノイズで食い潰して本命の入稿データが truncate で落ちる。
const PRINT_CHECKLIST_DESIGN_SKIP_RE = /^(?:当日写真|当日映像|06アフターフォロー|03ネガチェック|見積|バックアップ)/;
const PRINT_CHECKLIST_CATEGORY_RULES = [
  ['バックパネル', /バックパネル|背面|メインパネル|壁面グラフィック/i],
  ['ポスター', /ポスター|(?:^|[^a-z0-9])(?:A0|A1|A2|A3|B0|B1|B2)(?:[^a-z0-9]|$)|パネル|ボードパネル|スチレン/i],
  ['バナー・幕', /バナー|タペストリー|のぼり|幟|横断幕|懸垂幕|垂れ幕|幕|ターポリン|トロマット|クロス|ロールアップ|バナースタンド|Xバナー/i],
  ['看板・サイン', /看板|案内板|サイン|標識|社名|表示板|切り文字|切文字|カッティング|カルプ|司会台|演台/i],
  ['名札・カード', /名札|ネームプレート|スタッフ証|来場者証|入館証|名刺|番号札|テーブル名札|テーブル番号札|席札/i],
  ['紙モノ', /チラシ|フライヤー|リーフレット|パンフ|カタログ|冊子|POP|ポップ|プライスカード|アンケート|許可証|証明書|マニュアル|台本|進行表/i],
  ['その他印刷物', /印刷|出力|インクジェット|ラミネート|シート|ステッカー|シール|グラフィック|デザイン|データ|入稿|掲示/i]
];

function PrintChecklist_build(opts) {
  opts = opts || {};
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const explicitIds = Array.isArray(opts.caseIds) && opts.caseIds.length ? opts.caseIds.map(String) : null;
  const cases = _PrintChecklist_getCases(explicitIds);
  let index = explicitIds ? 0 : Math.max(0, Number(props.getProperty(PRINT_CHECKLIST_CURSOR_KEY)) || 0);
  if (index >= cases.length) index = 0;
  const ss = _PrintChecklist_getOrCreateSpreadsheet();
  const existing = _PrintChecklist_readExisting(ss);
  const exclusionRules = _PrintChecklist_readExclusionRules(ss);
  _PrintChecklist_applyPdReview(existing.rows, new Date());
  _PrintChecklist_learnExclusionRules(existing.rows, exclusionRules, new Date());
  const processedIds = {};
  const freshRows = [];
  const freshDesign = [];
  const scanNotes = {};
  const errors = [];
  let processed = 0;

  for (; index < cases.length; index++) {
    if (processed > 0 && Date.now() - started > PRINT_CHECKLIST_TIME_LIMIT_MS) break;
    const c = cases[index];
    try {
      const collected = _PrintChecklist_collectCase(c, false);
      Array.prototype.push.apply(freshRows, collected.rows);
      Array.prototype.push.apply(freshDesign, collected.designRows);
      if (collected.truncated) scanNotes[c.caseId] = 'デザインデータ走査を上限で打ち切り';
      processedIds[c.caseId] = true;
    } catch (e) {
      errors.push({ caseId: c.caseId, message: String(e && e.message ? e.message : e) });
    }
    processed++;
  }

  const now = new Date();
  const reconciliation = _PrintChecklist_reconcileRows(existing, freshRows, processedIds, exclusionRules, now);
  const merged = reconciliation.rows;
  _PrintChecklist_applyPdReview(merged, now);
  merged.sort(_PrintChecklist_compareRows);

  const pendingInstructions = _PrintChecklist_pendingInstructions(merged);

  const designRows = existing.designRows.filter(function (row) { return !processedIds[String(row[0] || '')]; });
  Array.prototype.push.apply(designRows, freshDesign);
  const errorMap = _PrintChecklist_readErrorMap(ss);
  Object.keys(processedIds).forEach(function (caseId) { delete errorMap[caseId]; });
  errors.forEach(function (x) { errorMap[x.caseId] = x.message; });
  _PrintChecklist_writeAll(ss, merged, designRows, cases, errorMap, scanNotes, now, exclusionRules, pendingInstructions);

  const partial = index < cases.length;
  if (!explicitIds && partial) {
    props.setProperty(PRINT_CHECKLIST_CURSOR_KEY, String(index));
  } else if (!explicitIds) {
    props.deleteProperty(PRINT_CHECKLIST_CURSOR_KEY);
    props.setProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY, Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd'));
  }
  const counts = _PrintChecklist_counts(merged, designRows);
  return {
    ok: true, ssId: ss.getId(), url: _PrintChecklist_ssUrl(ss.getId()), cases: processed,
    rows: counts.rows, missingData: counts.missingData, unmatchedFiles: counts.unmatchedFiles,
    elapsedMs: Date.now() - started, partial: partial, nextIndex: partial ? index : null, errors: errors,
    pendingInstructions: pendingInstructions,
    migrated: reconciliation.migrated, mergedDuplicates: reconciliation.mergedDuplicates
  };
}

function PrintChecklist_buildOne(caseId) {
  return PrintChecklist_build({ caseIds: [String(caseId || '')] });
}

function PrintChecklist_menuBuild() {
  const result = PrintChecklist_build({});
  try {
    SpreadsheetApp.getUi().alert(
      result.partial ? '印刷物チェックシートを途中まで更新しました（自動継続します）' : '印刷物チェックシートを更新しました',
      result.url,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) { /* トリガーやコマンドキューには UI がない */ }
  return result;
}

function PrintChecklist_installTrigger() {
  let triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    const handler = t.getHandlerFunction();
    if (handler === 'PrintChecklist_build' || handler === 'PrintChecklist_resumeBuild') ScriptApp.deleteTrigger(t);
  });
  triggers = ScriptApp.getProjectTriggers();
  const tickTriggers = triggers.filter(function (t) { return t.getHandlerFunction() === 'PrintChecklist_tick'; });
  tickTriggers.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (tickTriggers.length) return { ok: true, alreadyExists: true };
  try {
    ScriptApp.newTrigger('PrintChecklist_tick').timeBased().everyMinutes(10).create();
    return { ok: true, alreadyExists: false };
  } catch (e) {
    return { ok: false, reason: 'trigger-limit', triggerCount: ScriptApp.getProjectTriggers().length };
  }
}

function PrintChecklist_tick() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PRINT_CHECKLIST_CURSOR_KEY) !== null) return PrintChecklist_build({});
  const now = new Date();
  const today = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  const hour = Number(Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'H'));
  if (hour < 6 || props.getProperty(PRINT_CHECKLIST_LAST_RUN_DATE_KEY) === today) {
    return { ok: true, skipped: true };
  }
  return PrintChecklist_build({});
}

function _debug_listTriggers() {
  const triggers = ScriptApp.getProjectTriggers().map(function (t) {
    const handler = t.getHandlerFunction();
    const item = {
      handler: handler,
      type: String(t.getEventType()),
      uniqueId: t.getUniqueId()
    };
    if (handler === 'PrintChecklist_tick') item.everyMinutes = 10;
    return item;
  });
  return { total: triggers.length, triggers: triggers };
}

function _debug_printChecklistCase(caseId) {
  const c = CaseList_getById(String(caseId || ''));
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const result = _PrintChecklist_collectCase(c, true);
  return {
    caseId: c.caseId,
    itemSheetName: result.debug.itemListSheet,
    headerRow: result.debug.headerRow,
    cols: result.debug.columns,
    itemRowsTotal: result.debug.itemRowsTotal,
    itemRowsAdopted: result.debug.itemRowsAdopted,
    adoptedBy: result.debug.adoptedBy,
    itemSamples: result.debug.itemSamples,
    designRoot: result.debug.designRoot,
    designFilesTotal: result.debug.designFilesTotal,
    designByConfidence: result.debug.designByConfidence,
    designSamples: result.debug.designSamples,
    truncated: result.truncated,
    elapsedMs: result.debug.elapsedMs
  };
}

// CaseList_getById は毎回 getDataRange().getValues() を走らせるので、1 実行につき 1 回だけ全案件を
// 引き当ててメモ化する(素朴に呼ぶと build 1 回で 80 回シートを読み直して数十秒を捨てる)。
let _printChecklistCaseCache = null;

function _PrintChecklist_getCases(caseIds) {
  if (!_printChecklistCaseCache) {
    let base = [];
    if (typeof CaseList_getAll === 'function') base = CaseList_getAll() || [];
    else if (typeof CaseList_listAll === 'function') base = CaseList_listAll() || [];
    _printChecklistCaseCache = base.map(function (x) { return CaseList_getById(x.caseId) || x; }).filter(function (c) {
      if (!c || !c.caseId) return false;
      return !/(?:テスト|TEST|__DELETED)/i.test(String(c.clientName || '') + ' ' + String(c.caseName || ''));
    });
  }
  if (!caseIds) return _printChecklistCaseCache;
  const wanted = caseIds.reduce(function (m, id) { m[String(id)] = true; return m; }, {});
  return _printChecklistCaseCache.filter(function (c) { return wanted[c.caseId]; });
}

function _PrintChecklist_collectCase(c, debugOnly) {
  const started = Date.now(), rows = [], designRows = [];
  const debug = { itemListSheet: '', headerRow: 0, columns: {}, itemRowsTotal: 0, itemRowsAdopted: 0,
    adoptedBy: { keyword: 0, link: 0 },
    itemSamples: [], designRoot: null, designFilesTotal: 0, designByConfidence: { '高': 0, '中': 0, '低': 0 }, designSamples: [] };
  let zissi = null;
  if (c.zissiId) zissi = SpreadsheetApp.openById(c.zissiId);
  if (zissi) {
    const primary = _PrintChecklist_readPrimary(zissi, c, debug);
    Array.prototype.push.apply(rows, primary);
    const proposals = _PrintChecklist_readProposals(zissi, c);
    Array.prototype.push.apply(rows, proposals);
  }
  const design = _PrintChecklist_collectDesignFiles(c);
  debug.designRoot = design.root; debug.designFilesTotal = design.files.length;
  design.files.forEach(function (p) {
    debug.designByConfidence[p.conf]++;
    const targets = rows.filter(function (r) { return _PrintChecklist_namesMatch(r[9], p.name); });
    designRows.push([c.caseId, c.clientName || '', p.conf, p.parent, p.name, p.ext, p.updated, targets.length ? '済' : '未', p.url]);
  });
  const kouryou = zissi ? _PrintChecklist_readKouryouMap(zissi, debug) : null;
  debug.kouryou = kouryou ? {
    sheetName: kouryou.sheetName, headerRow: kouryou.headerRow + 1,
    kouryouCols: kouryou.kouryouCols.map(function (c2) { return c2 + 1; }),
    entries: kouryou.entries.length
  } : null;
  let matchedEntries = 0;
  // マッチ対象は「校了データを入れる前の行」に固定する。rows を直接見ると、
  // 先に校了データから起票した行に後続の校了データが部分一致で吸われ、別アイテムの入稿データが混ざる。
  const kouryouTargets = rows.slice();
  if (kouryou) kouryou.entries.forEach(function (e) {
    const targets = kouryouTargets.filter(function (r) { return _PrintChecklist_namesMatch(r[9], e.name); });
    if (targets.length) {
      matchedEntries++;
      targets.forEach(function (r) {
        r[13] = _PrintChecklist_uniqueLines(r[13], e.urls.join('\n'));
        r[14] = 'あり';
      });
    } else {
      rows.push(_PrintChecklist_makeRow(c, _PrintChecklist_itemKey(c.caseId, e.name),
        _PrintChecklist_classify(e.name, true), e.name, '', '', '',
        e.urls.join('\n'), 'あり', '制作物一覧(行' + e.rowNum + ')',
        '校了データあり・アイテムリスト未マッチ', new Date()));
    }
  });
  debug.kouryouMatched = matchedEntries;
  debug.itemRowsAdopted = rows.filter(function (r) { return String(r[15]).indexOf('アイテムリスト') === 0; }).length;
  debug.designSamples = design.files.slice(0, 15).map(function (p) { return { name: p.name, parent: p.parent, conf: p.conf, url: p.url }; });
  debug.elapsedMs = Date.now() - started;
  return { rows: rows, designRows: designRows, truncated: design.truncated, debug: debug };
}

function _PrintChecklist_readPrimary(zissi, c, debug) {
  let sheet = zissi.getSheetByName('アイテムリスト');
  if (!sheet) sheet = zissi.getSheets().filter(function (s) {
    return s.getName().indexOf('アイテムリスト') >= 0 && s.getName().indexOf('Claude_') !== 0;
  })[0];
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  // 実施計画書は 3〜10MB あり、getRichTextValues() をシート全域に掛けると GAS の 6 分制限で必ず落ちる
  // (実測: C0040/C0038 のプローブがここで無応答になった)。全域は表示値だけ読み、
  // リンク付きセルの取得は、入稿データが記載され得る品名・備考・注意事項列だけに絞る。
  const rowCount = Math.min(sheet.getLastRow(), PRINT_CHECKLIST_MAX_ITEM_ROWS);
  const colCount = sheet.getLastColumn();
  const range = sheet.getRange(1, 1, rowCount, colCount);
  const values = range.getValues();
  const displays = range.getDisplayValues();
  const detected = _PrintChecklist_detectHeaders(displays);
  const richCols = {};
  const linkCols = _PrintChecklist_uniqueColumns(detected.nameCols.map(function (entry) { return entry.col; })
    .concat([detected.note, detected.note2, detected.caution]));
  linkCols.forEach(function (col) {
    try { richCols[col] = sheet.getRange(1, col + 1, rowCount, 1).getRichTextValues(); } catch (e) { richCols[col] = null; }
  });
  debug.itemListSheet = sheet.getName(); debug.headerRow = detected.row + 1; debug.columns = detected.labels;
  debug.itemRowsTotal = Math.max(0, values.length - detected.row - 1);
  // ヘッダーを見つけられなくてもシートを丸ごと捨ててはいけない(=その案件の印刷物が黙って全部消える)。
  // 品名列が特定できない場合は「行内で最も長いテキストセル」を品名とみなして全行を走査する。
  // 採否は下の「印刷キーワード or 入稿データらしいリンク」判定に任せる。
  const nameless = detected.nameCols.length === 0;
  if (nameless) debug.columns = { fallback: '品名列を検出できずフォールバック走査' };
  const out = [];
  for (let r = detected.row + 1; r < values.length; r++) {
    const names = nameless ? [_PrintChecklist_longestCellWithCol(displays[r])] : detected.nameCols.map(function (entry) {
      return { col: entry.col, value: String(displays[r][entry.col] || '').trim() };
    });
    const notes = _PrintChecklist_join([_PrintChecklist_cell(displays[r], detected.note), _PrintChecklist_cell(displays[r], detected.note2)]);
    const caution = _PrintChecklist_cell(displays[r], detected.caution);
    const scopedCols = nameless ? _PrintChecklist_uniqueColumns([names[0].col, detected.note, detected.note2, detected.caution]) : linkCols;
    const scopedDisplay = scopedCols.map(function (col) { return displays[r][col]; });
    const scopedRich = scopedCols.map(function (col) { return _PrintChecklist_richCellAt(richCols, r, col); });
    const sourceUrls = _PrintChecklist_urlsForRow(scopedDisplay, scopedRich);
    const urls = _PrintChecklist_expandLinkedFolders(sourceUrls);
    names.forEach(function (name) {
      const fullName = name.value;
      if (!fullName) return;
      const haystack = _PrintChecklist_join([fullName, notes, caution]);
      const byKeyword = _PrintChecklist_hasKeyword(haystack);
      const byLink = sourceUrls.some(_PrintChecklist_isSubmissionLink);
      if (!byKeyword && !byLink) return;
      debug.adoptedBy[byKeyword ? 'keyword' : 'link']++;
      const cleanName = _PrintChecklist_removeUrls(fullName) || fullName;
      const size = _PrintChecklist_size(displays[r], detected);
      const qty = _PrintChecklist_number(_PrintChecklist_cell(values[r], detected.qty));
      const spec = _PrintChecklist_extractSpecs(_PrintChecklist_join([fullName, notes, caution]));
      const place = _PrintChecklist_cell(displays[r], detected.place);
      const status = _PrintChecklist_cell(displays[r], detected.status);
      const note = _PrintChecklist_join([notes, caution, '元セル全文: ' + fullName,
        urls.length ? '参考URL(元セル): ' + urls.join(' ') : '',
        place ? '倉庫: ' + place : '', status ? '状態: ' + status : '']);
      const id = _PrintChecklist_itemKey(c.caseId, cleanName);
      out.push(_PrintChecklist_makeRow(c, id,
        _PrintChecklist_classify(haystack, urls.length > 0), cleanName, size, qty, spec,
        '', 'なし', 'アイテムリスト(行' + (r + 1) + ')', note, new Date()));
      if (debug.itemSamples.length < 10) debug.itemSamples.push({ name: cleanName, qty: qty, urls: urls });
    });
  }
  return out;
}

function _PrintChecklist_readProposals(zissi, c) {
  const sheet = zissi.getSheetByName('Claude_アイテムリスト提案');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const count = sheet.getLastRow() - 1;
  const range = sheet.getRange(2, 1, count, Math.max(8, sheet.getLastColumn()));
  const values = range.getValues(), displays = range.getDisplayValues();
  let rich = null;
  try { rich = range.getRichTextValues(); } catch (e) { rich = null; }
  const allowed = /^(グラフィック|印刷物|造作物|サイン|什器)$/;
  const out = [];
  displays.forEach(function (r, i) {
    const category = String(r[0] || '').trim(), fullName = String(r[1] || '').trim();
    if (!fullName || (!allowed.test(category) && !_PrintChecklist_hasKeyword(fullName))) return;
    const urls = _PrintChecklist_expandLinkedFolders(_PrintChecklist_urlsForRow(r, rich ? rich[i] : []));
    const cleanName = _PrintChecklist_removeUrls(fullName) || fullName;
    out.push(_PrintChecklist_makeRow(c, _PrintChecklist_itemKey(c.caseId, cleanName),
      _PrintChecklist_classify(category + ' ' + fullName, urls.length > 0), cleanName,
      r[3], _PrintChecklist_number(values[i][2]), r[3], '', 'なし',
      'Claude提案', _PrintChecklist_join([r[6], 'カテゴリ: ' + category,
        urls.length ? '参考URL(元セル): ' + urls.join(' ') : '']), new Date()));
  });
  return out;
}

function _PrintChecklist_readKouryouMap(zissi, debug) {
  debug = debug || {};
  try {
    let sheet = zissi.getSheetByName('制作物一覧');
    if (!sheet) sheet = zissi.getSheets().filter(function (s) {
      return s.getName().indexOf('制作物一覧') >= 0 && s.getName().indexOf('Claude_') !== 0;
    })[0];
    if (!sheet) return null;
    const lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
    if (lastColumn < 1) return null;
    const headerCount = Math.min(20, Math.max(1, lastRow));
    const headerValues = sheet.getRange(1, 1, headerCount, lastColumn).getDisplayValues();
    const normalizeHeader = function (v) { return String(v || '').replace(/[\s　\n]/g, ''); };
    let headerRow = -1;
    for (let r = 0; r < headerValues.length && headerRow < 0; r++) {
      if (headerValues[r].some(function (v) { return /^項目$/.test(normalizeHeader(v)); })) headerRow = r;
    }
    if (headerRow < 0) headerRow = 5;
    const headers = headerValues[headerRow] || [];
    const itemCols = [], kouryouCols = [];
    headers.forEach(function (v, col) {
      const h = normalizeHeader(v);
      if (/^項目$/.test(h)) itemCols.push(col);
      if (/^校了(?:ﾃﾞｰﾀ|データ)(?:URL)?$/.test(h)) kouryouCols.push(col);
    });
    if (!kouryouCols.length) return null;
    const endRow = Math.min(lastRow, PRINT_CHECKLIST_MAX_ITEM_ROWS);
    const rowsScanned = Math.max(0, endRow - headerRow - 1);
    if (!rowsScanned) return { sheetName: sheet.getName(), headerRow: headerRow, kouryouCols: kouryouCols,
      itemCols: itemCols, rowsScanned: 0, entries: [] };
    const displays = sheet.getRange(headerRow + 2, 1, rowsScanned, lastColumn).getDisplayValues();
    const richCols = {};
    kouryouCols.forEach(function (col) {
      richCols[col] = sheet.getRange(1, col + 1, endRow, 1).getRichTextValues();
    });
    const entries = [];
    displays.forEach(function (row, i) {
      const name = itemCols.map(function (col) { return String(row[col] || '').trim(); }).filter(Boolean)[0];
      if (!name) return;
      const displayCells = kouryouCols.map(function (col) { return row[col]; });
      const richCells = kouryouCols.map(function (col) { return richCols[col][headerRow + 1 + i][0]; });
      const urls = _PrintChecklist_urlsForRow(displayCells, richCells);
      if (urls.length) entries.push({ name: name, urls: urls, rowNum: headerRow + 2 + i });
    });
    return { sheetName: sheet.getName(), headerRow: headerRow, kouryouCols: kouryouCols,
      itemCols: itemCols, rowsScanned: rowsScanned, entries: entries };
  } catch (e) {
    debug.kouryouError = String(e && e.stack ? e.stack : e);
    return null;
  }
}

function _PrintChecklist_detectHeaders(rows) {
  const result = { row: 0, name: -1, nameCols: [], qty: -1, size: -1, height: -1, width: -1, depth: -1,
    note: -1, note2: -1, status: -1, caution: -1, place: -1, code: -1, labels: {} };
  let best = null;
  const nameRowsByCol = {};
  for (let r = 0; r < Math.min(40, rows.length); r++) {
    const candidate = { row: r, score: 0 };
    rows[r].forEach(function (v, col) {
      const h = String(v || '').trim().toLowerCase().replace(/[\s　]/g, '');
      if (/^(アイテム名|品名|品目|品目名|item|name)$/.test(h)) {
        if (nameRowsByCol[col] === undefined) nameRowsByCol[col] = r;
        candidate.name = col; candidate.score += 10;
      }
      if (/^(現場必要数|数量|個数|必要数|qty|quantity)$/.test(h)) { candidate.qty = col; candidate.score += 3; }
      if (/^サイズ$/.test(h)) candidate.size = col;
      if (/^サイズ縦$|^縦$/.test(h)) candidate.height = col;
      if (/^サイズ横$|^横$/.test(h)) candidate.width = col;
      if (/^サイズ高さ$|^高さ$|^奥行$/.test(h)) candidate.depth = col;
      if (/^備考(:手入力)?$/.test(h)) candidate.note = col;
      if (/^備考[２2]$/.test(h)) candidate.note2 = col;
      if (/^(ｽﾃｰﾀｽ|ステータス)$/.test(h)) candidate.status = col;
      if (/^注意事項$/.test(h)) candidate.caution = col;
      if (/^場所$/.test(h)) candidate.place = col;
      if (/^(ｺｰﾄﾞ|コード)$/.test(h)) candidate.code = col;
    });
    if (candidate.name !== undefined && (!best || candidate.score > best.score)) best = candidate;
  }
  if (best) Object.keys(result).forEach(function (key) { if (best[key] !== undefined) result[key] = best[key]; });
  result.nameCols = Object.keys(nameRowsByCol).map(function (col) {
    return { col: Number(col), row: nameRowsByCol[col] };
  }).sort(function (a, b) { return a.col - b.col; });
  if (result.nameCols.length) {
    result.row = Math.min.apply(null, result.nameCols.map(function (entry) { return entry.row; }));
    result.name = result.nameCols[0].col;
  }
  Object.keys(result).forEach(function (key) {
    if (key !== 'row' && key !== 'labels' && key !== 'nameCols' && result[key] >= 0) result.labels[key] = result[key] + 1;
  });
  result.labels.nameCols = result.nameCols.map(function (entry) { return entry.col + 1; });
  return result;
}

function _PrintChecklist_collectDesignFiles(c) {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'pc_design_' + c.caseId;
  try {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* キャッシュ障害時は通常走査を続ける */ }
  try {
    const saved = JSON.parse(props.getProperty(cacheKey) || 'null');
    if (saved && Number(saved.scannedAt) > Date.now() - PRINT_CHECKLIST_DESIGN_PROPERTY_TTL_MS && saved.result) {
      return saved.result;
    }
  } catch (e) { /* 壊れた値や Properties 障害時は通常走査を続ける */ }
  const started = Date.now();
  const candidates = _PrintChecklist_unique([Case_resolveProjectRoot(c), c.projectFolderId, c.folderId]);
  let work = null;
  for (let i = 0; i < candidates.length && !work; i++) {
    const rootId = candidates[i];
    try {
      work = Azukari_findWorkRoot(rootId);
      if (!work) {
        const f = DriveApp.getFolderById(rootId);
        work = { id: f.getId(), name: f.getName() };
      }
    } catch (e) { work = null; }
  }
  if (!work) return { root: null, files: [], truncated: false };
  const out = [], queue = [{ folder: DriveApp.getFolderById(work.id), depth: 0 }];
  let truncated = false;
  while (queue.length) {
    if (out.length >= PRINT_CHECKLIST_DESIGN_MAX_FILES || Date.now() - started >= PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS) { truncated = true; break; }
    const node = queue.shift(), parentName = node.folder.getName(), files = node.folder.getFiles();
    while (files.hasNext()) {
      if (out.length >= PRINT_CHECKLIST_DESIGN_MAX_FILES || Date.now() - started >= PRINT_CHECKLIST_DESIGN_TIME_LIMIT_MS) { truncated = true; break; }
      const f = files.next(), info = _PrintChecklist_designFileInfo(f, parentName);
      if (info) out.push(info);
    }
    if (truncated || node.depth >= 4) continue;
    const folders = node.folder.getFolders();
    while (folders.hasNext()) {
      const child = folders.next();
      if (!PRINT_CHECKLIST_DESIGN_SKIP_RE.test(String(child.getName() || '').replace(/[\s　]/g, ''))) queue.push({ folder: child, depth: node.depth + 1 });
    }
  }
  const result = { root: { id: work.id, name: work.name }, files: out, truncated: truncated };
  if (!truncated) {
    try {
      const json = JSON.stringify(result);
      if (Utilities.newBlob(json).getBytes().length <= 100 * 1024) cache.put(cacheKey, json, 21600);
      const savedJson = JSON.stringify({ scannedAt: Date.now(), result: result });
      if (Utilities.newBlob(savedJson).getBytes().length <= PRINT_CHECKLIST_DESIGN_PROPERTY_MAX_BYTES) {
        props.setProperty(cacheKey, savedJson);
      }
    } catch (e) { /* 容量超過やキャッシュ障害時は保存せず、次回走査する */ }
  }
  return result;
}

function _PrintChecklist_designFileInfo(file, parentName) {
  const name = file.getName(), mime = file.getMimeType(), lower = name.toLowerCase();
  if (/^(?:result_|cmd_|construction_plan_setup_)/i.test(name)) return null;
  if (mime === 'application/vnd.google-apps.spreadsheet') return null;
  if (mime === 'application/vnd.google-apps.document' && /フォルダがない場合は作成してください/.test(name)) return null;
  const m = lower.match(/\.([a-z0-9]+)$/), ext = m ? m[1] : (mime === 'application/vnd.google-apps.presentation' ? 'Google Slides' : mime === 'application/vnd.google-apps.document' ? 'Google Docs' : '');
  if (!/^(?:ai|eps|psd|indd|pdf|svg|zip|png|jpg|jpeg|tif|tiff)$/.test(ext) && ext !== 'Google Slides' && ext !== 'Google Docs') return null;
  const text = name + ' ' + parentName;
  const high = /入稿|入校|outline|アウトライン|印刷|出力|データ入稿|完全データ|CMYK|原寸|K100/i.test(text);
  const medium = /^(?:ai|eps|psd|indd)$/.test(ext) || /パネル|ポスター|バナー|幕|看板|サイン|名札|ロゴ|グラフィック|タペストリー|のぼり|シート/i.test(text);
  return { id: file.getId(), name: name, parent: parentName, ext: ext, updated: file.getLastUpdated(), url: file.getUrl(), conf: high ? '高' : medium ? '中' : '低' };
}

function _PrintChecklist_makeRow(c, id, category, name, size, qty, spec, urls, dataState, source, note, updated) {
  const start = _PrintChecklist_date(c.startDate), end = _PrintChecklist_date(c.endDate);
  const deadline = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 14) : '';
  return [id, '未入稿', c.caseId, c.clientName || '', c.caseName || '', _PrintChecklist_period(start, end),
    start || '', deadline, category, name, size || '', qty === null ? '' : qty, spec || '', urls || '',
    dataState || '要確認', source, note || '', false, '未確認', '', '', '', '', '', updated || new Date(), '未確認'];
}

function _PrintChecklist_getOrCreateSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (saved) {
    try { return SpreadsheetApp.openById(saved); } catch (e) { /* 作り直す */ }
  }
  const ss = SpreadsheetApp.create(PRINT_CHECKLIST_SS_NAME);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getFolderById(APP_ROOT_FOLDER_ID));
  props.setProperty(PRINT_CHECKLIST_SS_ID_KEY, ss.getId());
  return ss;
}

function _PrintChecklist_readExisting(ss) {
  const rows = [];
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return;
    const colCount = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, colCount).getDisplayValues()[0];
    const headerIndex = {};
    headers.forEach(function (header, i) { headerIndex[String(header || '').trim()] = i; });
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
    values.forEach(function (sourceRow) {
      const row = PRINT_CHECKLIST_HEADERS.map(function (header) {
        return headerIndex[header] === undefined ? '' : sourceRow[headerIndex[header]];
      });
      row[PRINT_CHECKLIST_PD_REVIEW_COL] = row[PRINT_CHECKLIST_PD_REVIEW_COL] || '未確認';
      if (row[0]) rows.push(row);
    });
  });
  const byId = {};
  rows.forEach(function (r) { if (r[0]) byId[String(r[0])] = r; });
  const designSheet = ss.getSheetByName(PRINT_CHECKLIST_DESIGN_SHEET);
  const designRows = designSheet && designSheet.getLastRow() > 1 ?
    designSheet.getRange(2, 1, designSheet.getLastRow() - 1, 9).getValues() : [];
  return { rows: rows, byId: byId, designRows: designRows };
}

// 行・列位置ではなく、正規化した品名で固定する。既存 EX-ID のハッシュは変更しない。
function _PrintChecklist_stableHash8(value) {
  var h = 2166136261, s = String(value || '');
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function _PrintChecklist_itemKey(caseId, name) {
  return String(caseId) + '-IT' + _PrintChecklist_stableHash8(_PrintChecklist_normalize(name));
}

function _PrintChecklist_mergeById(rows) {
  var byId = Object.create(null), result = [];
  var col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  rows.forEach(function (source) {
    var id = String(source[col('印刷ID')]), row = byId[id];
    if (!row) {
      row = source.slice(); byId[id] = row; result.push(row);
      row[col('数量')] = _PrintChecklist_number(row[col('数量')]) || '';
      return;
    }
    PRINT_CHECKLIST_HEADERS.forEach(function (header, i) {
      if (header === '数量') {
        row[i] = Math.max(_PrintChecklist_number(row[i]) || 0, _PrintChecklist_number(source[i]) || 0) || '';
      } else if (header === '発生源') {
        row[i] = _PrintChecklist_unique(String(row[i] || '').split(' / ').concat(String(source[i] || '').split(' / '))).join(' / ');
      } else if (header === '備考' || header === 'デザインデータ') {
        row[i] = _PrintChecklist_uniqueLines(row[i], source[i]);
      } else if (header === '最終更新') {
        if ((new Date(source[i]).getTime() || 0) > (new Date(row[i]).getTime() || 0)) row[i] = source[i];
      } else if (row[i] === '' || row[i] == null) {
        row[i] = source[i];
      }
    });
  });
  return result;
}

// 純ロジックとして分離し、GAS に接続せず移行・再実行・部分更新を検証できるようにする。
function _PrintChecklist_reconcileRows(existing, freshRows, processedIds, exclusionRules, now) {
  var fresh = _PrintChecklist_mergeById(freshRows), freshById = Object.create(null);
  var legacyByName = Object.create(null), consumed = [], migrated = 0;
  var mergedDuplicates = freshRows.length - fresh.length;
  var col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  var nameKey = function (row) { return row[col('案件ID')] + '|' + _PrintChecklist_normalize(row[col('品名')]); };
  existing.rows.forEach(function (row) {
    // -DF は従来の削除・ソース消滅処理だけに渡す。
    if (!processedIds[String(row[col('案件ID')])] || /-DF\d+$/.test(String(row[col('印刷ID')]))) return;
    var key = nameKey(row);
    if (!legacyByName[key]) legacyByName[key] = [];
    legacyByName[key].push(row);
  });
  fresh.forEach(function (row) {
    freshById[row[col('印刷ID')]] = row;
    var group = legacyByName[nameKey(row)] || [];
    var chosen = existing.byId[row[col('印刷ID')]];
    if (!chosen && group.length) {
      chosen = group.slice().sort(function (a, b) {
        return Number(_PrintChecklist_hasPrinterInput(b)) - Number(_PrintChecklist_hasPrinterInput(a)) ||
          (new Date(b[col('最終更新')]).getTime() || 0) - (new Date(a[col('最終更新')]).getTime() || 0);
      })[0];
    }
    if (chosen) _PrintChecklist_copyPreserved(chosen, row);
    if (group.length) {
      var legacyIds = [];
      group.forEach(function (oldRow) {
        consumed.push(oldRow);
        row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')], oldRow[col('備考')]);
        if (oldRow[col('印刷ID')] !== row[col('印刷ID')]) legacyIds.push(oldRow[col('印刷ID')]);
        // 採用されなかった行の異なる記入も監査用に残す（上書きや黙った欠落を避ける）。
        PRINT_CHECKLIST_PRESERVED_HEADERS.forEach(function (header) {
          var i = col(header), value = oldRow[i];
          if (value !== '' && value != null && String(value) !== String(row[i])) {
            row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')],
              '旧記入 [' + oldRow[col('印刷ID')] + '] ' + header + ': ' + String(value));
          }
        });
      });
      if (legacyIds.length) {
        migrated++;
        row[col('備考')] = _PrintChecklist_uniqueLines(row[col('備考')], '旧印刷ID: ' + _PrintChecklist_unique(legacyIds).join(' '));
      }
      mergedDuplicates += Math.max(0, group.length - 1);
    }
    // 重複旧行の一方だけが対象外でも、学習済みの除外ルールを優先する。
    if (_PrintChecklist_matchesExclusionRule(row, exclusionRules)) row[col('状態')] = '対象外';
  });
  var merged = [];
  existing.rows.forEach(function (oldRow) {
    if (consumed.indexOf(oldRow) >= 0) return;
    const id = String(oldRow[0] || '');
    const caseId = String(oldRow[2] || '');
    if (!processedIds[caseId]) {
      merged.push(oldRow);
    } else if (!freshById[id]) {
      // -DF 行(制作フォルダ走査から自動起票していた行)は起票をやめたので、行を残さず消す。
      // 残すと N列「デザインデータ」に校了データ以外の Drive URL が居座り続ける
      // (kim 指示: N列は制作物一覧の校了データだけ / 2026-09-03)。
      // 印刷会社の記入欄が空の行だけ消し、何か書かれていたら [ソース消滅] を付けて残す。
      if (/-DF\d+$/.test(id) && !_PrintChecklist_hasPrinterInput(oldRow) &&
          oldRow[PRINT_CHECKLIST_PD_REVIEW_COL] === '未確認' && !oldRow[23]) return;
      // 残す行でも N列は空にする。ソース消滅行は「校了データだけ」の改修より前に入った
      // Drive URL を持ち続けるので、そのままだと N列に非校了データが居座る
      // (実測: C0041 ファインスチール様に 1 行残っていた)。URL は備考へ退避する。
      const goneUrls = String(oldRow[13] || '').split('\n').filter(Boolean);
      oldRow[16] = _PrintChecklist_sourceGoneNote(_PrintChecklist_join([oldRow[16],
        goneUrls.length ? '参考URL(ソース消滅時): ' + goneUrls.join(' ') : '']));
      oldRow[13] = '';
      oldRow[14] = 'なし';
      oldRow[24] = now;
      merged.push(oldRow);
    }
  });
  Array.prototype.push.apply(merged, fresh);
  return { rows: merged, migrated: migrated, mergedDuplicates: mergedDuplicates };
}

function _PrintChecklist_copyPreserved(oldRow, newRow) {
  PRINT_CHECKLIST_PRESERVED_HEADERS.forEach(function (header) {
    const col = PRINT_CHECKLIST_HEADERS.indexOf(header);
    newRow[col] = oldRow[col] == null ? '' : oldRow[col];
  });
}

function _PrintChecklist_applyPdReview(rows, now) {
  rows.forEach(function (row) {
    row[PRINT_CHECKLIST_PD_REVIEW_COL] = row[PRINT_CHECKLIST_PD_REVIEW_COL] || '未確認';
    if (row[PRINT_CHECKLIST_PD_REVIEW_COL] === '対象外' && row[1] !== '対象外') {
      row[1] = '対象外';
      row[24] = now;
    }
  });
}

function _PrintChecklist_readExclusionRules(ss) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_EXCLUSION_RULE_SHEET);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  const colCount = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, colCount).getDisplayValues()[0];
  const index = {};
  headers.forEach(function (header, i) { index[String(header || '').trim()] = i; });
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues().map(function (sourceRow) {
    return PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS.map(function (header) {
      return index[header] === undefined ? '' : sourceRow[index[header]];
    });
  }).filter(function (row) { return row[0] && row[3]; });
}

function _PrintChecklist_learnExclusionRules(rows, rules, now) {
  const triggerRe = /今後も除外|常に除外|毎回不要|二度と出さない/;
  const dateLabel = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
  rows.forEach(function (row) {
    const instruction = String(row[23] || '').trim();
    const explicit = !/^\[反映済/.test(instruction) && triggerRe.test(instruction);
    if (!explicit && row[1] !== '対象外' && row[PRINT_CHECKLIST_PD_REVIEW_COL] !== '対象外') return;
    // 全案件スコープは「全案件」と明記された時だけ。明示トリガーでも既定は この案件のみ
    // (勝手に全案件へ広げると、他案件の印刷物が黙って消える = 印刷漏れになる)。
    const scope = explicit && instruction.indexOf('全案件') >= 0 ? '全案件' : 'この案件のみ';
    const caseId = scope === '全案件' ? '' : String(row[2] || '');
    const pattern = _PrintChecklist_normalize(row[9]);
    if (!pattern) return;
    const duplicate = rules.some(function (rule) {
      return String(rule[1]) === scope && String(rule[2] || '') === caseId && _PrintChecklist_normalize(rule[3]) === pattern;
    });
    if (!duplicate) {
      rules.push(['EX-' + _PrintChecklist_stableNumber(scope + '|' + caseId + '|' + pattern), scope, caseId,
        pattern, now, row[0]]);
    }
    if (explicit) row[23] = '[反映済 ' + dateLabel + '] ' + instruction;
  });
}

function _PrintChecklist_matchesExclusionRule(row, rules) {
  return rules.some(function (rule) {
    const inScope = rule[1] === '全案件' || (rule[1] === 'この案件のみ' && String(rule[2] || '') === String(row[2] || ''));
    const name = _PrintChecklist_normalize(row[9]);
    return inScope && ((name && name === _PrintChecklist_normalize(rule[3])) || _PrintChecklist_namesMatch(row[9], rule[3]));
  });
}

function _PrintChecklist_pendingInstructions(rows) {
  return rows.filter(function (row) {
    const instruction = String(row[23] || '').trim();
    return instruction && !/^\[反映済/.test(instruction);
  }).map(function (row) {
    return { printId: row[0], caseId: row[2], itemName: row[9], instruction: row[23] };
  });
}

function _PrintChecklist_writeExclusionRules(ss, rules) {
  rules.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_EXCLUSION_RULE_SHEET);
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_EXCLUSION_RULE_HEADERS, rules);
  if (rules.length) sheet.getRange(2, 5, rules.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  sheet.setColumnWidth(4, 280);
}

function PrintChecklist_protectSheets(opts) {
  const warningOnly = !!(opts && opts.warningOnly === true);
  const ss = _PrintChecklist_getOrCreateSpreadsheet();
  const names = [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET];
  let count = 0;
  names.forEach(function (name) {
    const sheet = _PrintChecklist_sheet(ss, name);
    const descriptions = ['PrintChecklist:' + name + ':A-Q', 'PrintChecklist:' + name + ':X-Y'];
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (protection) {
      if (descriptions.indexOf(protection.getDescription()) >= 0) protection.remove();
    });
    [[1, 17], [24, 2]].forEach(function (range, i) {
      const protection = sheet.getRange(1, range[0], sheet.getMaxRows(), range[1]).protect()
        .setDescription(descriptions[i]).setWarningOnly(warningOnly);
      if (!warningOnly) {
        try {
          // Session.getEffectiveUser() は userinfo.email スコープが必要で、追加すると
          // 既存トリガー全部の再認可が要る(2026-09-22 実測でここで落ちた)。
          // 所有者は removeEditors で外れないので、明示的な addEditor は不要。
          protection.removeEditors(protection.getEditors());
          if (protection.canDomainEdit()) protection.setDomainEdit(false);
        } catch (e) {
          console.error('PrintChecklist 保護設定失敗: ' + descriptions[i] + ': ' + String(e));
          throw e;
        }
      }
    });
    count += 2;
  });
  return { ok: true, protections: count, warningOnly: warningOnly };
}

function _PrintChecklist_writeAll(ss, rows, designRows, currentCases, errorMap, scanNotes, now, exclusionRules, pendingInstructions) {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const caseMap = {};
  _PrintChecklist_getCases(null).forEach(function (c) { caseMap[c.caseId] = c; });
  const main = [], past = [], excluded = [];
  rows.forEach(function (r) {
    if (r[1] === '対象外') { excluded.push(r); return; }
    const c = caseMap[String(r[2] || '')];
    const eventDate = c ? (_PrintChecklist_date(c.endDate) || _PrintChecklist_date(c.startDate)) : null;
    (eventDate && eventDate < cutoff ? past : main).push(r);
  });
  _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_MAIN_SHEET), main);
  _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_PAST_SHEET), past);
  _PrintChecklist_writeListSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_EXCLUDED_SHEET), excluded);
  const rank = { '高': 0, '中': 1, '低': 2 };
  designRows.sort(function (a, b) { return (rank[a[2]] === undefined ? 2 : rank[a[2]]) - (rank[b[2]] === undefined ? 2 : rank[b[2]]) || String(a[0]).localeCompare(String(b[0])); });
  _PrintChecklist_writeDesignSheet(_PrintChecklist_sheet(ss, PRINT_CHECKLIST_DESIGN_SHEET), designRows);
  _PrintChecklist_writeSummary(ss, rows, currentCases, caseMap, errorMap, scanNotes, main);
  _PrintChecklist_invalidateReviewCache(now);
  _PrintChecklist_writeExclusionRules(ss, exclusionRules);
  _PrintChecklist_writeGuide(ss, now, pendingInstructions);
  const obsoleteDesignSheet = ss.getSheetByName('未マッチのデザインデータ');
  if (obsoleteDesignSheet && ss.getSheets().length > 1) ss.deleteSheet(obsoleteDesignSheet);
  const defaultSheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_SUMMARY_SHEET, PRINT_CHECKLIST_DESIGN_SHEET,
    PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET, PRINT_CHECKLIST_GUIDE_SHEET,
    PRINT_CHECKLIST_EXCLUSION_RULE_SHEET].forEach(function (name, i) {
    ss.setActiveSheet(ss.getSheetByName(name)); ss.moveActiveSheet(i + 1);
  });
}

function _PrintChecklist_writeListSheet(sheet, rows) {
  _PrintChecklist_resize(sheet, Math.max(2, rows.length + 1), PRINT_CHECKLIST_HEADERS.length);
  sheet.getRange(1, 1, 1, PRINT_CHECKLIST_HEADERS.length).setValues([PRINT_CHECKLIST_HEADERS]);
  if (rows.length) sheet.getRange(2, 1, rows.length, PRINT_CHECKLIST_HEADERS.length).setValues(rows);
  if (sheet.getLastRow() > rows.length + 1) sheet.getRange(rows.length + 2, 1, sheet.getLastRow() - rows.length - 1, PRINT_CHECKLIST_HEADERS.length).clearContent();
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, PRINT_CHECKLIST_HEADERS.length).setFontWeight('bold').setBackground('#d9ead3');
  sheet.getRange(1, 18, 1, 6).setBackground('#fce5cd');
  sheet.getRange(1, 24).setBackground('#d0e0e3');
  sheet.getRange(1, 26).setBackground('#d9d2e9').setNote('社内用（弊社プロデューサー記入欄）。印刷会社様は記入不要です。');
  sheet.setColumnWidth(26, 160);
  if (rows.length) {
    sheet.getRange(2, 26, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(PRINT_CHECKLIST_PD_REVIEW_VALUES, true).setAllowInvalid(false).build());
    sheet.getRange(2, 26, rows.length, 1).setBackgrounds(rows.map(function (r) {
      return [!r[25] || r[25] === '未確認' ? '#fff2cc' : '#ffffff'];
    }));
    sheet.getRange(2, 7, rows.length, 2).setNumberFormat('yyyy/MM/dd');
    sheet.getRange(2, 20, rows.length, 2).setNumberFormat('yyyy/MM/dd');
    sheet.getRange(2, 25, rows.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
    sheet.getRange(2, 14, rows.length, 1).setWrap(true);
    sheet.getRange(2, 2, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(PRINT_CHECKLIST_STATUS_VALUES, true).setAllowInvalid(false).build());
    sheet.getRange(2, 18, rows.length, 1).insertCheckboxes();
    sheet.getRange(2, 18, rows.length, 1).setValues(rows.map(function (r) { return [r[17]]; }));
    sheet.getRange(2, 19, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(PRINT_CHECKLIST_DATA_CHECK_VALUES, true).setAllowInvalid(false).build());
  }
  sheet.setColumnWidth(10, 260); sheet.setColumnWidth(14, 300); sheet.setColumnWidth(17, 320);
  sheet.setColumnWidth(23, 240); sheet.setColumnWidth(24, 300);
}

function _PrintChecklist_writeSimpleSheet(sheet, headers, rows) {
  _PrintChecklist_resize(sheet, Math.max(2, rows.length + 1), headers.length);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#d9ead3');
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  if (sheet.getLastRow() > rows.length + 1) sheet.getRange(rows.length + 2, 1, sheet.getLastRow() - rows.length - 1, headers.length).clearContent();
  sheet.setFrozenRows(1);
}

function _PrintChecklist_writeDesignSheet(sheet, rows) {
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_DESIGN_HEADERS, rows);
  if (!rows.length) return;
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('yyyy/MM/dd HH:mm');
  const colors = rows.map(function (r) {
    return new Array(PRINT_CHECKLIST_DESIGN_HEADERS.length).fill(r[2] === '高' && r[7] === '未' ? '#fff2cc' : '#ffffff');
  });
  sheet.getRange(2, 1, rows.length, PRINT_CHECKLIST_DESIGN_HEADERS.length).setBackgrounds(colors);
  sheet.setColumnWidth(5, 320); sheet.setColumnWidth(9, 300);
}

function _PrintChecklist_writeSummary(ss, rows, currentCases, caseMap, errorMap, scanNotes, main) {
  var reviewCounts = _PrintChecklist_reviewCounts(main || []);
  const counts = {};
  rows.forEach(function (r) {
    const id = String(r[2] || '');
    if (!counts[id]) counts[id] = { total: 0, yes: 0, no: 0, pending: 0 };
    counts[id].total++; if (r[14] === 'あり') counts[id].yes++; if (r[14] === 'なし') counts[id].no++; if (r[1] === '未入稿') counts[id].pending++;
  });
  const ids = {};
  rows.forEach(function (r) { ids[String(r[2] || '')] = true; });
  currentCases.forEach(function (c) { ids[c.caseId] = true; });
  const data = Object.keys(ids).sort().map(function (id) {
    const c = caseMap[id] || CaseList_getById(id) || { caseId: id }, n = counts[id] || { total: 0, yes: 0, no: 0, pending: 0 };
    const start = _PrintChecklist_date(c.startDate), end = _PrintChecklist_date(c.endDate);
    const deadline = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 14) : '';
    return [id, c.clientName || '', c.caseName || '', _PrintChecklist_period(start, end), deadline, n.total, n.yes, n.no, n.pending,
      c.zissiId ? _PrintChecklist_ssUrl(c.zissiId) : '', _PrintChecklist_projectUrl(c), _PrintChecklist_join([errorMap[id] || '', scanNotes[id] || '']), reviewCounts[id] || 0];
  });
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_SUMMARY_SHEET);
  _PrintChecklist_writeSimpleSheet(sheet, PRINT_CHECKLIST_SUMMARY_HEADERS, data);
  if (data.length) {
    sheet.getRange(2, 5, data.length, 1).setNumberFormat('yyyy/MM/dd');
    const backgrounds = data.map(function (r) { return new Array(PRINT_CHECKLIST_SUMMARY_HEADERS.length).fill(Number(r[7]) > 0 ? '#f4cccc' : '#ffffff'); });
    sheet.getRange(2, 1, data.length, PRINT_CHECKLIST_SUMMARY_HEADERS.length).setBackgrounds(backgrounds);
  }
  // 最終行の直下に不具合・要望フォームへの導線を置く(本表のヘッダー位置は動かさない)。
  const linkRow = data.length + 2;
  _PrintChecklist_resize(sheet, linkRow, PRINT_CHECKLIST_SUMMARY_HEADERS.length);
  sheet.getRange(linkRow, 1).clearContent();
  _PrintChecklist_writeLinkCell(sheet, linkRow, 1, '🐛 不具合・要望を報告する（画像も貼れます）',
    PrintChecklist_feedbackFormUrl(ss.getId()));
}

/** 不具合・要望フォームの URL を組み立てる。未設定なら '' を返す(導線を出さない)。 */
function PrintChecklist_feedbackFormUrl(ssId) {
  var base = '';
  try { base = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_FORM_URL_KEY) || ''; } catch (e) { base = ''; }
  if (!base) return '';
  const src = ssId ? _PrintChecklist_ssUrl(ssId) : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'form=feedback'
    + '&app=' + encodeURIComponent(PRINT_CHECKLIST_FORM_APP_NAME)
    + (src ? '&src=' + encodeURIComponent(src) : '');
}

/** 指定セルにリンク付きテキストを書く。URL が空なら何もしない。 */
function _PrintChecklist_writeLinkCell(sheet, row, col, text, url) {
  if (!url) return false;
  const rich = SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(url).build();
  sheet.getRange(row, col).setRichTextValue(rich);
  return true;
}

function _PrintChecklist_writeGuide(ss, now, pendingInstructions) {
  const sheet = _PrintChecklist_sheet(ss, PRINT_CHECKLIST_GUIDE_SHEET);
  const formUrl = PrintChecklist_feedbackFormUrl(ss.getId());
  const feedbackText = 'このシートの不具合・要望はこちら → 🐛 不具合・要望を報告する（画像も貼れます）';
  const rows = [
    ['印刷物チェックシート 凡例・使い方'],
    ['この表に載っているものが印刷をお願いしたい制作物の全件です'],
    ['行は絶対に削除しないでください。印刷しないものは B列「状態」を「対象外」にしてください。次回更新時にこの案件の除外ルールへ自動登録され、以後この表には出ず「対象外(除外済)」シートで保持されます。B列を編集できない方は Z列「社内確認(PD)」で対象外にしてください。'],
    ['行を削除すると、次回の自動更新で記入内容が失われたまま同じ品物が「未入稿」として復活します（除外ルール登録前の削除に注意してください）。'],
    ['印刷IDは品名から生成される固定値です。実施計画書の行を増やしてもIDは変わりません。'],
    ['全案件で除外したい場合は X列「AIへの指示」に「今後も除外」「常に除外」「毎回不要」「二度と出さない」のいずれかを記入してください（保護列の編集は管理者へ依頼してください）。'],
    ['オレンジ色の R〜W 列が印刷会社様の記入欄です。ここに書いた内容は自動更新で消えません。'],
    ['Z列「社内確認(PD)」は弊社プロデューサーの記入欄です。印刷会社様は記入不要です。'],
    ['Z列を「対象外」にすると、翌日の自動更新で状態が「対象外」になり 対象外(除外済) シートへ移動します。'],
    ['B 列「状態」と S 列「データ確認」はプルダウンから選べます。'],
    ['H列「印刷締切目安」は会期初日の14日前を機械的に示した目安であり、確定納期ではありません。'],
    ['N列「デザインデータ」は、各案件の実施計画書「制作物一覧」シートの「校了データ」列だけを表示します。空欄は「まだ校了していない」という意味で、社内マニュアルや参考画像のリンクは載りません。'],
    ['データ有無が「なし」の行は、自社側でデザインデータの入稿待ちです。'],
    ['生成日時: ' + Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd HH:mm:ss')],
    ['生成元: ブース制作アプリ 案件一覧']
  ];
  // フォーム URL が未設定のときは導線を出さない(例外にせず空文字で握りつぶす)。
  let feedbackRow = -1;
  if (formUrl) {
    feedbackRow = rows.length + 1;
    rows.push([feedbackText]);
    rows.push(['送信された内容は開発担当（kim）に直接届きます。返信で対応方針を伝えると、そのまま修正作業に回ります。']);
  }
  rows.push(['未処理のAIへの指示: ' + pendingInstructions.length + ' 件']);
  pendingInstructions.forEach(function (item) {
    rows.push([item.printId + ' / ' + item.caseId + ' / ' + item.itemName + ' / ' + item.instruction]);
  });
  _PrintChecklist_resize(sheet, rows.length, 1);
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  if (sheet.getLastRow() > rows.length) sheet.getRange(rows.length + 1, 1, sheet.getLastRow() - rows.length, 1).clearContent();
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14).setBackground('#d9ead3');
  sheet.setColumnWidth(1, 720); sheet.getRange(1, 1, rows.length, 1).setWrap(true);
  if (feedbackRow > 0) _PrintChecklist_writeLinkCell(sheet, feedbackRow, 1, feedbackText, formUrl);
}

function _PrintChecklist_sheet(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function _PrintChecklist_resize(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}
function _PrintChecklist_readErrorMap(ss) {
  const sheet = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET), out = {};
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 12) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues().forEach(function (r) { if (r[0] && r[11]) out[String(r[0])] = String(r[11]); });
  return out;
}
function _PrintChecklist_urlsForRow(displayRow, richRow) {
  const urls = [];
  displayRow.forEach(function (value, i) {
    const matches = String(value || '').match(/https?:\/\/[^\s　<>"']+/g) || [];
    Array.prototype.push.apply(urls, matches.map(function (u) { return u.replace(/[),.;、。]+$/, ''); }));
    const rich = richRow[i];
    if (rich && typeof rich.getLinkUrl === 'function') {
      const whole = rich.getLinkUrl(); if (whole) urls.push(whole);
      if (typeof rich.getRuns === 'function') rich.getRuns().forEach(function (run) { const u = run.getLinkUrl(); if (u) urls.push(u); });
    }
  });
  return _PrintChecklist_unique(urls);
}
function _PrintChecklist_expandLinkedFolders(urls) {
  const out = urls.slice();
  urls.forEach(function (url) {
    const m = String(url || '').match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders|folders)\/([a-zA-Z0-9_-]+)/);
    if (!m) return;
    try {
      const folder = DriveApp.getFolderById(m[1]), files = folder.getFiles();
      while (files.hasNext()) {
        const info = _PrintChecklist_designFileInfo(files.next(), folder.getName());
        if (info && info.conf !== '低') out.push(info.url);
      }
    } catch (e) { /* URL 自体は残し、権限不足などは読み飛ばす */ }
  });
  return _PrintChecklist_unique(out);
}
function _PrintChecklist_isSubmissionLink(url) {
  const text = String(url || '');
  if (/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[a-zA-Z0-9_-]+/i.test(text)) return true;
  return /入稿|入校|outline|アウトライン|印刷|データ/i.test(text) || /\.(?:ai|eps|psd|indd)(?:[?#].*)?$/i.test(text);
}
function _PrintChecklist_classify(text, hasUrl) {
  for (let i = 0; i < PRINT_CHECKLIST_CATEGORY_RULES.length; i++) if (PRINT_CHECKLIST_CATEGORY_RULES[i][1].test(String(text || ''))) return PRINT_CHECKLIST_CATEGORY_RULES[i][0];
  return '要判断';
}
function _PrintChecklist_hasKeyword(text) {
  text = String(text || '');
  // 「シート」などの広い語だけで、明らかな工具・消耗品を印刷物として採用しない。
  if (/養生テープ|梱包用.*テープ|粘着テープ|除菌シート|ウェットティッシュ|文房具セット/i.test(text) &&
      !/入稿|入校|outline|アウトライン|印刷|出力|データ|パネル|ボード|看板|サイン|グラフィック/i.test(text)) return false;
  return PRINT_CHECKLIST_CATEGORY_RULES.some(function (r) { return r[1].test(text); });
}
function _PrintChecklist_normalize(value) {
  let s = String(value || '');
  try { s = s.normalize('NFKC'); } catch (e) { /* V8 は通常対応 */ }
  s = s.replace(/^(?:[●★◆]+|【[^】]*】|メール添付_|\s|コピー)+/i, '')
    .replace(/(?:のコピー|_共有|_更新|見本|閲覧用)/gi, '')
    .replace(/\d{6,8}/g, '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return s.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[\s　\p{P}\p{S}]/gu, '');
}
function _PrintChecklist_namesMatch(a, b) {
  a = _PrintChecklist_normalize(a); b = _PrintChecklist_normalize(b);
  if (a.length <= 2 || b.length <= 2) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}
function _PrintChecklist_removeUrls(value) { return String(value || '').replace(/https?:\/\/[^\s　<>"']+/g, '').replace(/\s+/g, ' ').trim(); }
function _PrintChecklist_unique(values) { const seen = {}; return values.filter(function (v) { v = String(v || '').trim(); if (!v || seen[v]) return false; seen[v] = true; return true; }); }
function _PrintChecklist_uniqueLines(a, b) { return _PrintChecklist_unique((String(a || '') + '\n' + String(b || '')).split('\n')).join('\n'); }
function _PrintChecklist_join(values) { return values.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' / '); }
function _PrintChecklist_richCellAt(richCols, rowIndex, col) {
  const richCol = richCols[col], richRow = richCol && richCol[rowIndex];
  return richRow ? richRow[0] : null;
}
function _PrintChecklist_uniqueColumns(cols) {
  const seen = {};
  return cols.filter(function (col) {
    if (col < 0 || seen[col]) return false;
    seen[col] = true;
    return true;
  });
}
function _PrintChecklist_longestCell(row) {
  return _PrintChecklist_longestCellWithCol(row).value;
}
function _PrintChecklist_longestCellWithCol(row) {
  let best = { col: 0, value: '' };
  (row || []).forEach(function (v, col) {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (s.length > best.value.length) best = { col: col, value: s };
  });
  return best;
}
function _PrintChecklist_cell(row, col) { return col >= 0 ? row[col] : ''; }
function _PrintChecklist_number(value) { if (value === '' || value === null || value === undefined) return null; const m = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); if (!m) return null; const n = Number(m[0]); return isFinite(n) ? n : null; }
function _PrintChecklist_size(row, detected) {
  if (detected.size >= 0 && row[detected.size]) {
    const size = String(row[detected.size]).trim();
    return /^-?\d+(?:\.\d+)?$/.test(size.replace(/,/g, '')) ? '' : size;
  }
  const dimensions = [
    detected.height >= 0 && row[detected.height] ? '縦' + row[detected.height] : '',
    detected.width >= 0 && row[detected.width] ? '横' + row[detected.width] : '',
    detected.depth >= 0 && row[detected.depth] ? '高さ' + row[detected.depth] : ''
  ].filter(Boolean);
  return dimensions.length >= 2 ? dimensions.join(' / ') : '';
}
function _PrintChecklist_extractSpecs(value) {
  const matches = String(value || '').match(/両面|片面|カラー|白黒|モノクロ|防炎|防災|ラミネート|マット|グロス|光沢|ツヤ|ハトメ|袋縫い|周囲縫製|トロマット|ターポリン|スエード|パンチカーペット|スチレン|カルプ|アルミ複合板|塩ビ|ダイノック|インクジェット|出力|W\d+|H\d+|\d+(?:\.\d+)?mm|\d+(?:\.\d+)?cm|A[0-4]|B[0-4]|\d+部|\d+枚/gi) || [];
  return _PrintChecklist_unique(matches).join(' / ');
}
function _PrintChecklist_date(value) { if (!value) return null; const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value).replace(/\//g, '-')); return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function _PrintChecklist_period(start, end) { if (!start && !end) return '未定'; const f = function (d) { return d ? Utilities.formatDate(d, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd') : '未定'; }; return start && end ? f(start) + '〜' + f(end) : f(start || end); }
function _PrintChecklist_pad(n, width) { return ('000000' + n).slice(-width); }
function _PrintChecklist_stableNumber(value) { let h = 0, s = String(value || ''); for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0; return _PrintChecklist_pad(h % 1000000, 6); }
function _PrintChecklist_sourceGoneNote(note) { note = String(note || ''); return note.indexOf('[ソース消滅]') === 0 ? note : '[ソース消滅] ' + note; }
function _PrintChecklist_compareRows(a, b) { const ad = a[6] instanceof Date ? a[6].getTime() : Number.MAX_SAFE_INTEGER, bd = b[6] instanceof Date ? b[6].getTime() : Number.MAX_SAFE_INTEGER; return ad - bd || String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0])); }
function _PrintChecklist_ssUrl(id) { return 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + id + '/edit'; }
function _PrintChecklist_projectUrl(c) { const id = c.projectFolderId || c.folderId || ''; return id ? 'https://drive.google.com/drive/folders/' + id : ''; }
function _PrintChecklist_counts(rows, designRows) { return { rows: rows.length, missingData: rows.filter(function (r) { return r[14] === 'なし'; }).length, unmatchedFiles: designRows.filter(function (r) { return r[7] === '未'; }).length }; }

function _debug_kouryouSurvey(startIndex) {
  const started = Date.now(), cases = _PrintChecklist_getCases(null);
  let index = Math.max(0, Number(startIndex) || 0);
  const results = [];
  for (; index < cases.length; index++) {
    // 1案件あたり実施計画書(3〜10MB)を開くので重い。6分制限で死ぬと結果が返らないため
    // 予算は 120 秒に抑え、nextIndex を返して呼び出し側でチェーンする。
    if (Date.now() - started > 120000) return { ok: true, done: false, nextIndex: index, results: results };
    const c = cases[index];
    if (!c.zissiId) {
      results.push({ caseId: c.caseId, error: 'zissiIdなし' });
      continue;
    }
    try {
      const debug = {};
      const map = _PrintChecklist_readKouryouMap(SpreadsheetApp.openById(c.zissiId), debug);
      if (debug.kouryouError) {
        results.push({ caseId: c.caseId, error: debug.kouryouError });
        continue;
      }
      results.push({
        caseId: c.caseId, clientName: c.clientName || '', caseName: c.caseName || '',
        sheetName: map ? map.sheetName : '', headerRow: map ? map.headerRow + 1 : null,
        kouryouCols: map ? map.kouryouCols.map(function (col) { return col + 1; }) : [],
        rowsScanned: map ? map.rowsScanned : 0, entries: map ? map.entries.length : 0,
        samples: map ? map.entries.slice(0, 3).map(function (entry) {
          return { name: entry.name, urls: entry.urls.map(function (url) { return String(url).slice(0, 120); }) };
        }) : []
      });
    } catch (e) {
      results.push({ caseId: c.caseId, error: String(e && e.stack ? e.stack : e) });
    }
  }
  return {
    ok: true, done: true, total: cases.length,
    withSheet: results.filter(function (r) { return Boolean(r.sheetName); }).length,
    withEntries: results.filter(function (r) { return r.entries > 0; }).length,
    results: results
  };
}

// 印刷会社側の記入欄(受領・データ確認・印刷予定日・納品予定日・御社担当者・印刷会社メモ)に
// 何か入っているか。入っていれば自動生成由来の行でも消さない。
function _PrintChecklist_hasPrinterInput(row) {
  const cols = ['受領', 'データ確認', '印刷予定日', '納品予定日', '御社担当者', '印刷会社メモ'];
  return cols.some(function (header) {
    const v = row[PRINT_CHECKLIST_HEADERS.indexOf(header)];
    if (v === true) return true;
    const s = String(v === undefined || v === null ? '' : v).trim();
    return Boolean(s) && s !== '未確認' && s !== 'false';
  });
}

/** 設定の照会のみ。未設定・アクセス不可でも新規作成しない。 */
function _debug_printChecklistSsId() {
  var id = '';
  try {
    id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY) || '';
    if (!id) return { id: '', exists: false };
    var ss = SpreadsheetApp.openById(id);
    return { id: id, name: ss.getName(), url: _PrintChecklist_ssUrl(id), exists: true };
  } catch (e) { return { id: id, name: '', url: id ? _PrintChecklist_ssUrl(id) : '', exists: false }; }
}

/** 印刷物チェックシートの共有状態を照会する。未設定・アクセス不可でも新規作成しない。 */
function _debug_printChecklistSharing() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('PRINT_CHECKLIST_SS_ID');
    var file = DriveApp.getFileById(id);
    return {
      id: id,
      name: file.getName(),
      owner: file.getOwner().getEmail(),
      editors: file.getEditors().map(function (user) { return user.getEmail(); }),
      viewers: file.getViewers().map(function (user) { return user.getEmail(); }),
      access: String(file.getSharingAccess()),
      permission: String(file.getSharingPermission())
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

function _PrintChecklist_reviewCounts(rows) {
  var counts = {};
  (rows || []).forEach(function (r) {
    if (r[0] && r[2] && r[1] !== '対象外' && (!r[25] || r[25] === '未確認')) {
      counts[String(r[2])] = (counts[String(r[2])] || 0) + 1;
    }
  });
  return counts;
}

function _PrintChecklist_invalidateReviewCache(now) {
  // flush → キャッシュ破棄の順。次の読者が旧サマリを再キャッシュしないようにする。
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().setProperty(PRINT_CHECKLIST_PD_ASOF_KEY, (now || new Date()).toISOString());
  try { CacheService.getScriptCache().remove(PRINT_CHECKLIST_PD_CACHE_KEY); } catch (e) {}
}

/** main の棚卸しだけを再集計する。ビルド不要で人の Z列編集をサマリへ反映。 */
function _PrintChecklist_refreshReviewSummary(ss) {
  var main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
  var summary = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET);
  if (!main || !summary || main.getLastColumn() < 26 || summary.getLastRow() < 2) return false;
  var headers = summary.getRange(1, 1, 1, summary.getLastColumn()).getValues()[0];
  var col = headers.indexOf('棚卸し未確認件数');
  if (col < 0) return false;
  var rows = main.getLastRow() > 1 ? main.getRange(2, 1, main.getLastRow() - 1, 26).getValues() : [];
  var counts = _PrintChecklist_reviewCounts(rows);
  var values = summary.getRange(2, 1, summary.getLastRow() - 1, headers.length).getValues();
  summary.getRange(2, col + 1, values.length, 1).setValues(values.map(function (r) {
    // 最下行の不具合報告リンクは案件として扱わない。
    return [r[col] === '' || r[col] == null ? '' : (counts[String(r[0])] || 0)];
  }));
  _PrintChecklist_invalidateReviewCache(new Date());
  return true;
}

function PrintChecklist_onReviewEdit(e) {
  if (!e || !e.range || e.range.getColumn() > 26 || e.range.getLastColumn() < 26 || e.range.getLastRow() < 2) return;
  if (e.range.getSheet().getName() !== PRINT_CHECKLIST_MAIN_SHEET) return;
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!e.source || e.source.getId() !== id) return;
  _PrintChecklist_refreshReviewSummary(e.source);
}

function PrintChecklist_installReviewTrigger() {
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) return { ok: false, reason: '未設定' };
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'PrintChecklist_onReviewEdit' && t.getTriggerSourceId() === id;
  });
  if (existing.length) return { ok: true, alreadyExists: true };
  ScriptApp.newTrigger('PrintChecklist_onReviewEdit').forSpreadsheet(id).onEdit().create();
  return { ok: true, alreadyExists: false };
}

/**
 * 案件サマリのみを読む。戻り値 {count, url, found, asOf}。
 * キャッシュは10分、SS IDと計算時刻も照合。旧版の列欠落を0件と誤認しない。
 */
function PrintChecklist_pendingReviewCount(caseId) {
  var missing = { found: false, count: 0, url: '', asOf: null };
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    if (!id) return missing;
    var asOf = props.getProperty(PRINT_CHECKLIST_PD_ASOF_KEY) || '';
    var cache = null, saved = null;
    try {
      cache = CacheService.getScriptCache();
      saved = JSON.parse(cache.get(PRINT_CHECKLIST_PD_CACHE_KEY) || 'null');
    } catch (e) {}
    if (!saved || saved.id !== id || saved.asOf !== asOf) {
      var ss = SpreadsheetApp.openById(id);
      var summary = ss.getSheetByName(PRINT_CHECKLIST_SUMMARY_SHEET);
      if (!summary || summary.getLastRow() < 2) return missing;
      var values = summary.getDataRange().getValues();
      var countCol = values[0].indexOf('棚卸し未確認件数');
      var idCol = values[0].indexOf('案件ID');
      if (countCol < 0 || idCol < 0) return missing;
      var main = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
      saved = { id: id, asOf: asOf, url: (main ? PanelLinks_sheetUrlById(_PrintChecklist_ssUrl(id), main.getSheetId()) : _PrintChecklist_ssUrl(id)), counts: {} };
      values.slice(1).forEach(function (row) {
        var n = row[countCol];
        if (row[idCol] && n !== '' && n != null && isFinite(Number(n)) && Number(n) >= 0) {
          saved.counts[String(row[idCol])] = Number(n);
        }
      });
      try {
        // 案件ごとの値は件数のみ。巨大ならキャッシュを諦めても結果は返す。
        var json = JSON.stringify(saved);
        if (cache && Utilities.newBlob(json).getBytes().length < 95 * 1024) cache.put(PRINT_CHECKLIST_PD_CACHE_KEY, json, 600);
      } catch (e) {}
    }
    var found = Object.prototype.hasOwnProperty.call(saved.counts, String(caseId));
    return { found: found, count: found ? saved.counts[String(caseId)] : 0, url: saved.url,
      asOf: saved.asOf && !isNaN(new Date(saved.asOf).getTime()) ? new Date(saved.asOf) : null };
  } catch (e) { return missing; }
}

/** 夜間巡回の先頭で1回実行。タイムアウトで巡回末尾へ届かなくても通知を落とさない。 */
function PrintChecklist_nagPendingReview(caseIds) {
  var lock = null, locked = false;
  try {
    var props = PropertiesService.getScriptProperties();
    var webhook = props.getProperty('DISCORD_ASSIGN_WEBHOOK');
    var id = props.getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    if (!webhook || !id) return { sent: false, skipped: true };
    var now = new Date(), day = Utilities.formatDate(now, PRINT_CHECKLIST_TZ, 'yyyy/MM/dd');
    lock = LockService.getScriptLock();
    locked = lock.tryLock(1000);
    if (!locked) return { sent: false, skipped: true };
    if (props.getProperty('PRINT_CHECKLIST_PD_NAG_DATE') === day) return { sent: false, skipped: true };
    // 手編集イベントが欠落した場合も、夜間の同期前に確実に再計算する。
    _PrintChecklist_refreshReviewSummary(SpreadsheetApp.openById(id));
    var lines = [], url = _PrintChecklist_ssUrl(id);
    (caseIds || TaskLedger_activeCaseIds()).forEach(function (caseId) {
      var pr = PrintChecklist_pendingReviewCount(caseId);
      if (!pr.found || !pr.count) return;
      var c = CaseList_getById(caseId);
      if (!c) return;
      url = pr.url;
      lines.push(String(c.caseName || c.clientName || caseId).replace(/[\r\n]+/g, ' ') + '（' + caseId + '） / 制作P：' + TaskLedger_producerName(c) +
        ' / 未確認 ' + pr.count + '件 / 会期初日 ' + (c.startDate || '未定') + ' / 期限 ' + (TaskLedger_printReviewDue(c.startDate) || '未定'));
    });
    if (!lines.length) return { sent: false, pendingCases: 0 };
    var heading = url + '\n印刷物チェックシートの棚卸し（未完了 ' + lines.length + '案件）\n';
    var content = heading + lines.join('\n');
    var payload = { content: content, allowed_mentions: { parse: [] } };
    var options = { method: 'post', muteHttpExceptions: true };
    if (content.length <= 2000) {
      options.contentType = 'application/json'; options.payload = JSON.stringify(payload);
    } else {
      // Discord の2000文字制限でも分割投稿しない。全文を1通の添付に保持。
      payload.content = heading + '案件別の一覧は添付をご確認ください。';
      options.payload = { payload_json: JSON.stringify(payload), 'files[0]': Utilities.newBlob(content, 'text/plain', 'print-review.txt') };
    }
    var response = UrlFetchApp.fetch(webhook, options);
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) return { sent: false, pendingCases: lines.length, httpStatus: status };
    props.setProperty('PRINT_CHECKLIST_PD_NAG_DATE', day);
    return { sent: true, pendingCases: lines.length, httpStatus: status };
  } catch (e) { return { sent: false, error: '棚卸し通知に失敗しました' }; }
  finally { if (locked) lock.releaseLock(); }
}

/** 管理者の棚卸し入力口。印刷IDで照合し、R〜Xは一切書き換えない。 */
function _admin_printChecklistReview(caseId, patches) {
  if (!Array.isArray(patches)) throw new Error('patches は配列で指定してください');
  var id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
  if (!id) throw new Error('印刷物チェックシートが未設定です');
  var ss = SpreadsheetApp.openById(id), targets = {}, changes = [];
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET, PRINT_CHECKLIST_PAST_SHEET].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 26) return;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 26).getValues().forEach(function (r, i) {
      if (String(r[2]) === String(caseId)) targets[String(r[0])] = { sheet: sheet, row: i + 2, values: r };
    });
  });
  // 書き込み前に全件検証。expectedReviewで他の編集者の変更を上書きしない。
  patches.forEach(function (p) {
    var target = targets[String(p.printId)];
    if (!target) throw new Error('印刷IDが案件にありません: ' + p.printId);
    if (PRINT_CHECKLIST_PD_REVIEW_VALUES.indexOf(p.review) < 0) throw new Error('不正な社内確認値');
    if (p.expectedReview !== undefined && (target.values[25] || '未確認') !== p.expectedReview) throw new Error('棚卸し入力が変更されています: ' + p.printId);
    if (p.restoreStatus !== undefined && PRINT_CHECKLIST_STATUS_VALUES.indexOf(p.restoreStatus) < 0) throw new Error('不正な状態');
  });
  patches.forEach(function (p) {
    var t = targets[String(p.printId)];
    t.sheet.getRange(t.row, 26).setValue(p.review);
    if (p.restoreStatus !== undefined) t.sheet.getRange(t.row, 2).setValue(p.restoreStatus);
  });
  SpreadsheetApp.flush();
  patches.forEach(function (p) {
    var t = targets[String(p.printId)];
    var actual = t.sheet.getRange(t.row, 1, 1, 26).getValues()[0];
    if (actual[25] !== p.review || (p.restoreStatus !== undefined && actual[1] !== p.restoreStatus)) throw new Error('棚卸し入力の読み戻し不一致: ' + p.printId);
    if (JSON.stringify(actual.slice(17, 24)) !== JSON.stringify(t.values.slice(17, 24))) throw new Error('印刷会社入力の読み戻し不一致: ' + p.printId);
    changes.push({ printId: p.printId, sheet: t.sheet.getName(), status: actual[1], review: actual[25], printerInputPreserved: true });
  });
  _PrintChecklist_refreshReviewSummary(ss);
  return { updated: changes.length, changes: changes, pending: PrintChecklist_pendingReviewCount(caseId) };
}

// 読み取り専用の read-back verify。安定ID化(2026-09-22)が実データで効いたかを小さな JSON で返す。
// 旧形式ID(-IL/-CP/-KR)の残存数と、正規化品名の重複数が 0 であることを外から assert できる。
function _debug_printChecklistVerify(caseId) {
  const ss = _PrintChecklist_getOrCreateSpreadsheet();
  const col = function (header) { return PRINT_CHECKLIST_HEADERS.indexOf(header); };
  const out = { caseId: caseId || '(全件)', sheets: {}, legacyIds: 0, legacySamples: [], dupNames: [], excludedInMain: 0 };
  [PRINT_CHECKLIST_MAIN_SHEET, PRINT_CHECKLIST_PAST_SHEET, PRINT_CHECKLIST_EXCLUDED_SHEET].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { out.sheets[name] = 0; return; }
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, PRINT_CHECKLIST_HEADERS.length).getValues()
      .filter(function (r) { return r[col('印刷ID')] && (!caseId || String(r[col('案件ID')]) === String(caseId)); });
    out.sheets[name] = values.length;
    const seen = {};
    values.forEach(function (r) {
      const id = String(r[col('印刷ID')]);
      if (/-(IL\d+c\d+|CP\d+|KR\d+)$/.test(id)) {
        out.legacyIds++;
        if (out.legacySamples.length < 5) out.legacySamples.push(id);
      }
      if (name === PRINT_CHECKLIST_MAIN_SHEET && String(r[col('状態')]) === '対象外') out.excludedInMain++;
      const updated = new Date(r[col('最終更新')]).getTime();
      if (updated && (!out._maxUpdated || updated > out._maxUpdated)) out._maxUpdated = updated;
      const key = String(r[col('案件ID')]) + '|' + _PrintChecklist_normalize(r[col('品名')]);
      if (seen[key]) { if (out.dupNames.length < 10) out.dupNames.push({ sheet: name, name: String(r[col('品名')]), ids: [seen[key], id] }); }
      else seen[key] = id;
    });
  });
  const ruleSheet = ss.getSheetByName(PRINT_CHECKLIST_EXCLUSION_RULE_SHEET);
  out.exclusionRules = ruleSheet && ruleSheet.getLastRow() > 1 ? ruleSheet.getLastRow() - 1 : 0;
  // 強制保護(2026-09-22)の後も書き込みが通っているかを外から見るための指標。
  // 保護レンジへの setValues が silent ignore されると、ここが更新されず古い時刻で止まる。
  out.maxUpdated = out._maxUpdated ? Utilities.formatDate(new Date(out._maxUpdated), PRINT_CHECKLIST_TZ, 'yyyy/MM/dd HH:mm:ss') : '';
  delete out._maxUpdated;
  return out;
}
