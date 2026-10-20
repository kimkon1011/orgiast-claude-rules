const TASK_LEDGER_SHEET_NAME = 'Claude_タスク台帳';
const TASK_LEDGER_HEADERS = ['タスクID', '状態', '▶AI実行', 'タスク', '内容', '発生源', '根拠', '期限', '担当', 'AI機能', '実行結果', '実行日時', '修正指示', '登録日時', '更新日時', 'キー', '失敗回数'];
const TASK_LEDGER_STATUSES = ['未着手', '実行中', 'AI実行済(要確認)', '完了', '不要', '要人手'];

/** A列の値配列(2行目以降、1セルにつき1要素または[値]の行配列)から、taskIdが入っている最終インデックス(1始まり、無ければ1)を返す。 */
function TaskLedger_lastTaskRowFromValues(columnAValues) {
  var lastTaskRow = 1;
  (columnAValues || []).forEach(function (row, i) {
    var value = Array.isArray(row) ? row[0] : row;
    if (String(value == null ? '' : value).trim() !== '') lastTaskRow = i + 2;
  });
  return lastTaskRow;
}

/** taskId(A列)が入っている最終行。1行も無ければ1(ヘッダ行)を返す。 */
function _TaskLedger_lastTaskRow(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  return TaskLedger_lastTaskRowFromValues(sheet.getRange(2, 1, lastRow - 1, 1).getValues());
}

function TaskLedger_ensureSheet(zissiSs) {
  let sheet = zissiSs.getSheetByName(TASK_LEDGER_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(TASK_LEDGER_SHEET_NAME);
  sheet.getRange(1, 1, 1, 17).setValues([TASK_LEDGER_HEADERS]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  const widths = [80, 130, 70, 220, 420, 110, 280, 110, 100, 240, 280, 130, 280, 130, 130];
  widths.forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
  try { sheet.hideColumns(16, 2); } catch (e) {}
  // 折り返しは「書式」なので値を書かない = getLastRow を膨らませない (空行が残タスクに数えられた 2026-09-02 の事故の再発防止)
  [5, 7, 13].forEach(function (col) { sheet.getRange(2, col, Math.max(1, sheet.getMaxRows() - 1), 1).setWrap(true); });
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var lastTaskRow = _TaskLedger_lastTaskRow(sheet);
    if (lastTaskRow < lastRow) {
      // C列だけでは登録日時/更新日時/キー/失敗回数の残骸で getLastRow が縮まず穴が塞がらなかった (C0038 実測)。1〜17列を丸ごと消す
      sheet.getRange(lastTaskRow + 1, 1, lastRow - lastTaskRow, 17).clearDataValidations().clearContent();
      SpreadsheetApp.flush(); // clearContent 後に getLastRow を縮めてから追記させる
    }
  }
  try {
    var filter = sheet.getFilter();
    if (filter) filter.remove();
    sheet.getRange(1, 1, 1, 15).createFilter();
  } catch (e) {}
  return sheet;
}

function TaskLedger_normalizeKeyPart(text) {
  let value = String(text == null ? '' : text);
  value = value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  return value.replace(/[\s\u3000・、。\/()（）「」]/g, '').toLowerCase();
}

function TaskLedger_makeKey(source, taskName, keyRef) {
  // 表示名を変更しても既存の印刷物タスクと同じキーを維持する。
  if (source === '印刷物チェック' && taskName === '印刷物の仕分け（未確認の行を未入稿／入稿済／対象外にする）') taskName = '印刷物チェックシートの棚卸し（不要な行を対象外にする）';
  // keyRef(機能keyなど)があれば表示名ではなくそれでキーを作る(ラベル変更でも同じ行に当たる)。
  if (keyRef != null && String(keyRef) !== '') return String(source || '') + '|' + TaskLedger_normalizeKeyPart(keyRef);
  return String(source || '') + '|' + TaskLedger_normalizeKeyPart(taskName);
}

function TaskLedger_nextTaskId(existingIds) {
  let max = 0;
  (existingIds || []).forEach(function (id) {
    const match = /^T-(\d+)$/.exec(String(id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  });
  return 'T-' + String(max + 1).padStart(4, '0');
}

function TaskLedger_mergePlan(existingRows, incomingItems, now) {
  const byKey = {};
  const ids = [];
  (existingRows || []).forEach(function (row) { if (row.key && !byKey[row.key]) byKey[row.key] = row; if (row.taskId) ids.push(row.taskId); });
  const seen = {};
  const appends = [];
  const updates = [];
  const stats = { added: 0, updated: 0, autoCompleted: 0, reopened: 0, skipped: 0 };
  let nextId = TaskLedger_nextTaskId(ids);
  (incomingItems || []).forEach(function (item) {
    const key = TaskLedger_makeKey(item.source, item.taskName, item.keyRef);
    if (seen[key]) { stats.skipped++; return; }
    seen[key] = true;
    const row = byKey[key];
    if (!row) {
      if (item.sourceStatus !== 'open') { stats.skipped++; return; }
      appends.push({ item: item, taskId: nextId });
      stats.added++;
      nextId = TaskLedger_nextTaskId([nextId]);
      return;
    }
    if (item.source === '印刷物チェック' && item.refresh === true &&
        item.taskName === '印刷物の仕分け（未確認の行を未入稿／入稿済／対象外にする）' &&
        (row.status === '未着手' || (row.status === '完了' && item.reopen === true))) {
      updates.push({ rowIndex: row.rowIndex, patch: { 'タスク': item.taskName, '内容': item.detail || '', '根拠': item.evidence || '', '更新日時': now } });
    }
    if (item.reopen === true && item.sourceStatus === 'open' && row.status === '完了') {
      updates.push({ rowIndex: row.rowIndex, patch: { '状態': '未着手', '内容': item.detail || '', '更新日時': now } });
      stats.reopened++; return;
    }
    if (item.reopen === true && (row.status === '実行中' || row.status === 'AI実行済(要確認)')) { stats.skipped++; return; }
    if (row.status === '完了' || row.status === '不要' || row.status === '要人手') { stats.skipped++; return; }
    if (item.sourceStatus === 'done' && row.status === '未着手') {
      updates.push({ rowIndex: row.rowIndex, patch: { '状態': '完了', '更新日時': now } }); stats.autoCompleted++; return;
    }
    if (item.sourceStatus === 'unnecessary' && row.status === '未着手') {
      updates.push({ rowIndex: row.rowIndex, patch: { '状態': '不要', '更新日時': now } }); stats.autoCompleted++; return;
    }
    if (item.sourceStatus === 'open') {
      const patch = {};
      const panelRefresh = item.source === '実行パネル' && item.refresh === true;
      [['detail', '内容'], ['evidence', '根拠'], ['due', '期限'], ['owner', '担当'], ['aiFeature', 'AI機能']].forEach(function (pair) {
        var cur = String(row[pair[0]] == null ? '' : row[pair[0]]), next = String(item[pair[0]] == null ? '' : item[pair[0]]);
        var refreshable = item.refresh === true && (pair[0] === 'detail' || pair[0] === 'evidence');
        // 実行パネル行は毎回同じ値を書き直さない(差分がある時だけ)。期限・機能ラベルは未着手の行だけ揃える
        if (panelRefresh && refreshable) refreshable = next !== cur;
        if (panelRefresh && (pair[0] === 'due' || pair[0] === 'aiFeature') && row.status === '未着手' && next !== '' && next !== cur) refreshable = true;
        if (refreshable || (cur === '' && next !== '')) patch[pair[1]] = item[pair[0]] == null ? '' : item[pair[0]];
      });
      if (panelRefresh && row.status === '未着手' && item.taskName && String(row.taskName == null ? '' : row.taskName) !== String(item.taskName)) patch['タスク'] = item.taskName;
      if (Object.keys(patch).length) { patch['更新日時'] = now; updates.push({ rowIndex: row.rowIndex, patch: patch }); stats.updated++; }
      else stats.skipped++;
      return;
    }
    stats.skipped++;
  });
  return { appends: appends, updates: updates, stats: stats };
}

function TaskLedger_summarize(rows, today) {
  const base = today instanceof Date ? today : new Date(today);
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const summary = { total: 0, open: 0, overdue: 0, aiRunnable: 0, needsReview: 0 };
  (rows || []).forEach(function (row) {
    if (!String(row.taskId || '').trim() && !String(row.taskName || '').trim()) return;
    summary.total++;
    const open = row.status !== '完了' && row.status !== '不要';
    if (open) summary.open++;
    if (open && String(row.aiFeature || '') !== '') summary.aiRunnable++;
    if (row.status === 'AI実行済(要確認)') summary.needsReview++;
    const text = String(row.due || '').trim();
    let match = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(text);
    let due = null;
    if (match) {
      due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (due.getFullYear() !== Number(match[1]) || due.getMonth() !== Number(match[2]) - 1 || due.getDate() !== Number(match[3])) due = null;
    }
    else {
      match = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
      if (match) {
        due = new Date(day.getFullYear(), Number(match[1]) - 1, Number(match[2]));
        if (due.getMonth() !== Number(match[1]) - 1 || due.getDate() !== Number(match[2])) due = null;
      }
    }
    if (open && due && !isNaN(due.getTime()) && due < day) summary.overdue++;
  });
  return summary;
}

function TaskLedger_collect(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const items = [];
  const errors = [];
  if (c.masterCol) try {
    _MeetingAgenda_loadMaster(c).openTasks.forEach(function (task) {
      items.push({ source: 'master工程', taskName: task.taskName, detail: (task.category || '') + ' / ' + (task.phase || ''), evidence: 'タスク進捗管理表 列' + c.masterCol, due: '', owner: 'オージャスト', aiFeature: '', sourceStatus: 'open' });
    });
  } catch (e) { errors.push('master工程: ' + e.message); }
  try {
    var unresolved = ConfirmationSheet_getUnresolved(caseId);
    var preview = unresolved.slice(0, 5).map(function (item) { return String(item.content || item.category || '').trim(); }).filter(function (text) { return text !== ''; }).join(' / ');
    var detail = ('未回答 ' + unresolved.length + '件。内訳(先頭5件): ' + preview).slice(0, 200);
    items.push({ source: '確認シート', taskName: 'お客様・主催者への確認事項の回答をもらう', detail: detail, evidence: ConfirmationSheet_getUrl(caseId), due: '', owner: 'お客様', aiFeature: '', sourceStatus: unresolved.length ? 'open' : 'done', refresh: true });
  } catch (e) { errors.push('確認シート: ' + e.message); }
  try {
    var pr = PrintChecklist_pendingReviewCount(caseId);
    if (pr.found) items.push({
      source: '印刷物チェック', taskName: '印刷物の仕分け（未確認の行を未入稿／入稿済／対象外にする）',
      detail: ('仕分け待ち ' + pr.count + '件。「印刷物（元データ社内用）」シートで、印刷するものは B列「状態」を「未入稿」（これから入稿）か「入稿済」に、印刷しないものは「対象外」にしてください。未入稿・入稿済にした行だけが印刷会社様用シートに載ります。').slice(0, 200),
      evidence: pr.url, due: TaskLedger_printReviewDue(c.startDate), owner: TaskLedger_producerName(c),
      aiFeature: '', sourceStatus: pr.count > 0 ? 'open' : 'done', refresh: true, reopen: true
    });
  } catch (e) { errors.push('印刷物チェック: ' + e.message); }
  try {
    const zissiSs = _Procure_openZissi(c);
    const sheet = _Procure_itemSheet(zissiSs);
    const cols = _Procure_resolveColumns(sheet);
    const values = sheet.getLastRow() >= 3 ? sheet.getRange(3, 1, sheet.getLastRow() - 2, sheet.getLastColumn()).getDisplayValues() : [];
    values.forEach(function (row) {
      const name = String(row[cols['品名'] - 1] || '').trim();
      const status = String(row[cols['ステータス'] - 1] || '').trim();
      if (!name || ['未承認', '承認済', '手配済'].indexOf(status) < 0) return;
      items.push({ source: '手配物', taskName: '手配承認: ' + name, detail: String(row[cols['仕様/型番'] - 1] || '') + ' / 数量' + String(row[cols['手配数量'] - 1] || ''), evidence: (String(row[cols['根拠(議事録日付)'] - 1] || '') + ' ' + String(row[cols['根拠(該当発言)'] - 1] || '')).trim(), due: String(row[cols['必着日'] - 1] || ''), owner: 'オージャスト', aiFeature: '📮 承認済みを購買部へ手配依頼', sourceStatus: status === '未承認' ? 'open' : 'done' });
    });
  } catch (e) { errors.push('手配物: ' + e.message); }
  try { _TaskLedger_collectPanelItems(caseId, c).forEach(function (item) { items.push(item); }); }
  catch (e) { errors.push('実行パネル: ' + e.message); }
  return { items: items, errors: errors };
}

/* ===== 実行パネルの生成機能を台帳の行にする(フェーズ4) ===== */
const TASKLEDGER_PANEL_SOURCE = '実行パネル';

/** 取り込まない機能key: 送信系は別枠(sendingFeatureKeys)。ここは「下書きでも自動で回さない」もの(送信・入力待ち・定期自動で足りるもの)。 */
function TaskLedger_panelSeedExcludedKeys() {
  return ['assignSend', 'fromText', 'linkTranscript', 'refreshContext', 'mailAttachments', 'transferLinks', 'pendingRefresh', 'pendingApply'];
}

function _TaskLedger_dayMs(value) {
  if (value === '' || value == null) return NaN;
  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return NaN;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** フェーズ別の目安期限(yyyy/MM/dd)。common/sales/p1=開始-60日, p2=-14日, p3=-2日, onsite=開始日, after=終了日+7日。基準日が無ければ ''。 */
function TaskLedger_panelDueDate(phase, startRaw, endRaw) {
  var offsets = { common: -60, sales: -60, p1: -60, p2: -14, p3: -2, onsite: 0 };
  var base = NaN, add = 0;
  if (phase === 'after') { base = _TaskLedger_dayMs(endRaw); add = 7; }
  else if (offsets[phase] != null) { base = _TaskLedger_dayMs(startRaw); add = offsets[phase]; }
  if (isNaN(base)) return '';
  var d = new Date(base + add * 86400000);
  return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0');
}

/**
 * 実行パネルの機能を台帳の行(items)にする純関数。
 * ctx = { panelKeys: {機能key:true}|null(パネル無し=取り込まない), progress: PanelProgress_load の戻り, panelDone: {機能key:true}(パネルの✅列), startRaw, endRaw, evidence }
 * 生成済み = progress[key].done === true(PanelProgress が正) か パネルの✅済列が true。
 */
function TaskLedger_panelSeedItems(features, ctx) {
  ctx = ctx || {};
  if (!ctx.panelKeys) return [];
  var progress = ctx.progress || {}, panelDone = ctx.panelDone || {}, excluded = TaskLedger_panelSeedExcludedKeys(), sending = TaskLedger_sendingFeatureKeys(), seen = {}, out = [];
  (features || []).forEach(function (f) {
    if (!f || !f.key || seen[f.key]) return;
    if (sending.indexOf(f.key) >= 0 || excluded.indexOf(f.key) >= 0 || f.rare) return;
    if (!TaskLedger_isAutoRunnable(f) || !ctx.panelKeys[f.key]) return;
    seen[f.key] = true;
    var done = Boolean(progress[f.key] && progress[f.key].done === true) || panelDone[f.key] === true;
    out.push({
      source: TASKLEDGER_PANEL_SOURCE, keyRef: f.key, taskName: f.label, detail: 'フェーズ ' + f.phase, evidence: ctx.evidence || '',
      due: TaskLedger_panelDueDate(f.phase, ctx.startRaw, ctx.endRaw), owner: 'オージャスト', aiFeature: f.label,
      sourceStatus: done ? 'done' : 'open', refresh: true
    });
  });
  return out;
}

/** pollChecked: 「実行パネル行が無い案件」だけ、1tick 2案件まで・残り予算120秒以上・未試行の時に sync する判定。 */
function TaskLedger_shouldSeedPanel(state) {
  state = state || {};
  if (state.hasPanelRows === true || state.attempted === true) return false;
  if ((Number(state.seededThisTick) || 0) >= 2) return false;
  return Number(state.remainingMs) >= 120000;
}

function _TaskLedger_collectPanelItems(caseId, c) {
  var label = JobQueue_eventLabelForCase(caseId);
  if (!label) return [];
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS), panel = _Panel_findByLabel(ms, label);
  if (!panel) return [];
  var panelKeys = {}, panelDone = {}, last = panel.getLastRow();
  if (last >= PANEL_FIRST_FEATURE_ROW) {
    var n = last - PANEL_FIRST_FEATURE_ROW + 1;
    var keys = panel.getRange(PANEL_FIRST_FEATURE_ROW, 10, n, 1).getValues(), checks = panel.getRange(PANEL_FIRST_FEATURE_ROW, 2, n, 1).getValues();
    keys.forEach(function (r, i) { var k = String(r[0] || ''); if (k && k.indexOf('__PHASE__') !== 0) { panelKeys[k] = true; if (checks[i][0] === true) panelDone[k] = true; } });
  }
  var evidence = ''; try { evidence = PanelLinks_sheetUrl(ms, panel); } catch (e) {}
  return TaskLedger_panelSeedItems(_Panel_features(), { panelKeys: panelKeys, progress: PanelProgress_load(caseId), panelDone: panelDone, startRaw: c && c.startDate, endRaw: c && c.endDate, evidence: evidence });
}

function _TaskLedger_rowsFromSheet(sheet) {
  if (sheet.getLastRow() < 2) return [];
  var range = sheet.getRange(2, 1, sheet.getLastRow() - 1, 17);
  var formulas = range.getFormulas();
  return range.getValues().map(function (row, i) {
    if (formulas[i][10]) row[10] = formulas[i][10];
    return { rowIndex: i + 2, taskId: row[0], status: String(row[1] || ''), aiRun: row[2], taskName: row[3], detail: row[4], source: row[5], evidence: row[6], due: row[7] instanceof Date ? Utilities.formatDate(row[7], 'Asia/Tokyo', 'yyyy/MM/dd') : row[7], owner: row[8], aiFeature: row[9], result: row[10], ranAt: row[11], revision: row[12], registeredAt: row[13], updatedAt: row[14], key: row[15], failCount: row[16] };
  }).filter(function (row) { return String(row.taskId || '').trim() !== ''; });
}

function TaskLedger_upsert(caseId, items) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('タスク台帳が混雑しています。少し待ってもう一度実行してください');
  try {
    const c = CaseList_getById(caseId);
    if (!c) throw new Error('案件が見つかりません: ' + caseId);
    const zissiSs = _Zissi_open(c);
    const sheet = TaskLedger_ensureSheet(zissiSs);
    const existing = _TaskLedger_rowsFromSheet(sheet);
    const now = new Date();
    const plan = TaskLedger_mergePlan(existing, items, now);
    let appendStart = 0;
    if (plan.appends.length) {
      // getLastRow()+1 だと残骸のある行の下に追記されて穴が埋まらない (C0038 実測) ので taskId の最終行から数える
      appendStart = _TaskLedger_lastTaskRow(sheet) + 1;
      const rows = plan.appends.map(function (entry) { const x = entry.item; return [entry.taskId, '未着手', false, x.taskName || '', x.detail || '', x.source || '', x.evidence || '', x.due || '', x.owner || '', x.aiFeature || '', '', '', '', now, now, TaskLedger_makeKey(x.source, x.taskName, x.keyRef), 0]; });
      sheet.getRange(appendStart, 1, rows.length, 17).setValues(rows);
    }
    const columnByName = {};
    TASK_LEDGER_HEADERS.forEach(function (name, i) { columnByName[name] = i + 1; });
    plan.updates.forEach(function (update) { Object.keys(update.patch).forEach(function (name) { sheet.getRange(update.rowIndex, columnByName[name]).setValue(update.patch[name]); }); });
    if (plan.appends.length) {
      sheet.getRange(appendStart, 3, plan.appends.length, 1).insertCheckboxes();
      sheet.getRange(appendStart, 2, plan.appends.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(TASK_LEDGER_STATUSES).build());
      // read-back verify (setValues は silent ignore されうるため。既存 _admin_taskLedgerSetRow と同じ流儀)
      const writtenIds = sheet.getRange(appendStart, 1, plan.appends.length, 1).getValues();
      const expectedIds = plan.appends.map(function (entry) { return entry.taskId; });
      const verified = writtenIds.length === expectedIds.length && writtenIds.every(function (row, i) { return String(row[0]) === String(expectedIds[i]); });
      if (!verified) throw new Error('タスク台帳への追記を確認できませんでした（行' + appendStart + '〜）');
    }
    const sheetUrl = PanelLinks_sheetUrl(zissiSs, sheet);
    return { added: plan.stats.added, addedPanel: plan.appends.filter(function (x) { return x.item.source === TASKLEDGER_PANEL_SOURCE; }).length, updated: plan.stats.updated, autoCompleted: plan.stats.autoCompleted, reopened: plan.stats.reopened, skipped: plan.stats.skipped, sheetUrl: sheetUrl, taskIds: plan.appends.map(function (x) { return x.taskId; }) };
  } finally { lock.releaseLock(); }
}

function TaskLedger_readRows(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const zissiSs = _Zissi_open(c);
  const sheet = zissiSs.getSheetByName(TASK_LEDGER_SHEET_NAME);
  if (!sheet) return { sheetUrl: '', rows: [] };
  return { sheetUrl: PanelLinks_sheetUrl(zissiSs, sheet), rows: _TaskLedger_rowsFromSheet(sheet) };
}

function TaskLedger_sync(caseId) {
  const collected = TaskLedger_collect(caseId);
  const result = TaskLedger_upsert(caseId, collected.items);
  if (result.addedPanel > 0) {
    var panelItems = collected.items.filter(function (x) { return x.source === TASKLEDGER_PANEL_SOURCE; });
    var panelDone = panelItems.filter(function (x) { return x.sourceStatus === 'done'; }).length;
    try { TaskLedger_appendRunLog({ caseId: caseId, taskName: '(実行パネル取込 ' + result.addedPanel + '件)', route: 'seed', result: 'ok', message: 'open=' + (panelItems.length - panelDone) + ' done=' + panelDone }); }
    catch (e) { console.warn('seed log: ' + e); }
  }
  const read = TaskLedger_readRows(caseId);
  const summary = TaskLedger_summarize(read.rows, new Date());
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'タスク台帳', '残' + summary.open + '件 / 期限切れ' + summary.overdue + '件 / 新規' + result.added + '件', result.sheetUrl);
  return { sheetUrl: result.sheetUrl, sheetName: TASK_LEDGER_SHEET_NAME, added: result.added, updated: result.updated, autoCompleted: result.autoCompleted, reopened: result.reopened, open: summary.open, overdue: summary.overdue, needsReview: summary.needsReview, errors: collected.errors, panelStatus: '✅ 残タスク ' + summary.open + '件 (期限切れ ' + summary.overdue + '件 / 新規 ' + result.added + '件 / 再オープン ' + result.reopened + '件)' };
}

function TaskLedger_sendingFeatureKeys() {
  // meetingSeries: 顧客 MTG の招待(顧客メール宛)を sendUpdates:'all' で送るため外部送信扱い。
  // 夜間の自動実行で顧客へ無確認の招待が飛ぶのを防ぐ(設計書 §5「送信系以外を自動実行」)。
  return ['assignRequest', 'procurementSubmit', 'procurementQuick', 'meetingSeries'];
}

/**
 * 6分制限に当たりやすい重い生成。台帳からは実行せず、実行パネル(JobQueue = 1起動1ジョブ)経由で人が回す。
 * 判定基準: 出展マニュアル/図面などの PDF を documents として Claude に添付する機能は
 * ほぼ確実に 6 分に収まらない。2026-09-02 の実測で layoutPlan / logisticsPlan / submission が中断された
 * (submission は初回 5分45秒でギリギリ完走したが、修正指示を足した2回目で超過)。
 * 新しい機能を台帳から回す前に、まずここに入れるべきかを実測で判断すること。
 */
function TaskLedger_heavyFeatureKeys() {
  // driverHours / staffProposal: 外部呼び出しや実施計画書スタッフシート・更新案シートへの書き込みを行う。
  // 台帳の6分ポーリング内で回すと途中で切れて半端なセルが残りうるため、logisticsPlan と同じくパネル専用にする。
  return ['estimateUpdate', 'layoutPlan', 'logisticsPlan', 'staffProposal', 'driverHours', 'submission', 'constructionManual', 'operationsPlan', 'setupTeardown', 'proofCheck', 'nyukoCheck'];
}

function TaskLedger_isAutoRunnable(feature) {
  if (!feature || !feature.command || feature.noCase || feature.menu || feature.link) return false;
  if (TaskLedger_sendingFeatureKeys().indexOf(feature.key) >= 0) return false;
  return feature.key !== 'taskLedger' && feature.key !== 'onsitePlaceholder';
}

function _TaskLedger_featureByLabel(label) {
  var features = _Panel_features();
  for (var i = 0; i < features.length; i++) if (features[i].label === label) return features[i];
  return null;
}

function TaskLedger_normalizeFeatureLabel(label) {
  var normalized = String(label == null ? '' : label).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  var features = _Panel_features();
  for (var i = 0; i < features.length; i++) {
    if (String(features[i].label || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '') === normalized) return features[i].label;
  }
  return '';
}

function _TaskLedger_nowMs() { return new Date().getTime(); }
function _TaskLedger_readCursor(name) { return PropertiesService.getScriptProperties().getProperty(name) || ''; }
function _TaskLedger_writeCursor(name, value) { PropertiesService.getScriptProperties().setProperty(name, String(value || '')); }

function _TaskLedger_roundRobinCases(cases, cursor) {
  var list = (cases || []).slice();
  if (!list.length) return list;
  var index = list.indexOf(String(cursor || ''));
  if (index < 0) return list;
  return list.slice(index + 1).concat(list.slice(0, index + 1));
}

function _TaskLedger_writePatch(caseId, rowIndex, patch) {
  var c = CaseList_getById(caseId);
  var sheet = _Zissi_open(c).getSheetByName(TASK_LEDGER_SHEET_NAME);
  var columns = { status: 2, aiRun: 3, result: 11, ranAt: 12, updatedAt: 15, failCount: 17 };
  Object.keys(patch).forEach(function (key) { sheet.getRange(rowIndex, columns[key]).setValue(patch[key]); });
}

function TaskLedger_runTask(caseId, taskId, opts) {
  opts = opts || {};
  var t0 = new Date().getTime();
  _TaskLedger_runMeta = null;
  var ret = _TaskLedger_runTaskCore(caseId, taskId, opts);
  var meta = _TaskLedger_runMeta;
  _TaskLedger_runMeta = null;
  if (meta) {
    var result = ret && ret.ok === true ? 'ok' : (ret && (ret.prereq || ret.skipped) ? 'prereq' : 'fail');
    var message = ret && ret.ok === true ? String(ret.panelStatus || '') : String((ret && (ret.error || ret.reason)) || '');
    TaskLedger_appendRunLog({ caseId: caseId, taskName: meta.taskName, featureKey: meta.featureKey, route: opts.route || (opts.auto ? 'auto' : 'checked'), result: result, message: message, seconds: Math.round((new Date().getTime() - t0) / 1000) });
  }
  return ret;
}

function _TaskLedger_runTaskCore(caseId, taskId, opts) {
  opts = opts || {};
  var read = TaskLedger_readRows(caseId);
  var row = null;
  for (var i = 0; i < read.rows.length; i++) if (String(read.rows[i].taskId) === String(taskId)) { row = read.rows[i]; break; }
  if (!row) throw new Error('タスクが見つかりません: ' + taskId);
  if (row.status === '完了' || row.status === '不要') return { skipped: true, reason: '既に ' + row.status + ' のタスクです' };
  if (row.status === '要人手') return { skipped: true, reason: 'AI が3回失敗したタスクです。人手で対応してください' };
  if (!String(row.aiFeature || '').trim()) return { skipped: true, reason: 'AI で実行できるタスクではありません(人手で実施してください)' };
  var feature = _TaskLedger_featureByLabel(String(row.aiFeature));
  if (!feature) return { skipped: true, reason: '機能ラベルが実行パネルに見つかりません: ' + row.aiFeature };
  if (TaskLedger_heavyFeatureKeys().indexOf(feature.key) >= 0) return { skipped: true, reason: '時間のかかる機能です。🚀実行パネルの「' + feature.label + '」から実行してください（台帳から回すと6分制限で中断されます）' };
  if (row.status === '実行中' && row.ranAt) {
    var elapsed = _TaskLedger_nowMs() - new Date(row.ranAt).getTime();
    if (elapsed <= 30 * 60 * 1000) return { skipped: true, reason: 'このタスクは実行中です' };
    var timeoutFailCount = (Number(row.failCount) || 0) + 1;
    var timeoutNow = new Date(_TaskLedger_nowMs());
    _TaskLedger_writePatch(caseId, row.rowIndex, {
      status: timeoutFailCount >= 3 ? '要人手' : '未着手',
      result: '❌ 前回の実行が GAS の時間制限(6分)で中断されました(タイムアウト ' + timeoutFailCount + '回目)',
      updatedAt: timeoutNow,
      failCount: timeoutFailCount
    });
    row.failCount = timeoutFailCount;
    if (timeoutFailCount >= 3) {
      CaseList_touchUpdatedAt(caseId);
      return { skipped: true, reason: '時間制限で3回中断されました。この機能は実行パネルから人が実行してください' };
    }
  }
  if (opts.auto && !TaskLedger_isAutoRunnable(feature)) return { skipped: true, reason: '外部へ送信する機能のため自動実行しません。台帳の ▶AI実行 にチェックを入れてください' };
  _TaskLedger_runMeta = { taskName: row.taskName, featureKey: feature.key };
  var now = new Date();
  _TaskLedger_writePatch(caseId, row.rowIndex, { status: '実行中', ranAt: now, aiRun: false, updatedAt: now });
  SpreadsheetApp.flush();
  var ret;
  try {
    if (String(row.revision || '').trim()) ClaudeClient_setExtraInstruction(row.revision);
    var commands = _cmdQueue_commands();
    var command = commands[feature.command];
    if (!command) throw new Error('許可されていないコマンドです: ' + feature.command);
    ret = command.apply(null, [caseId].concat(feature.args || []));
  } catch (err) {
    var failure = TaskLedger_failurePatch(row.failCount, String(err), new Date());
    _TaskLedger_writePatch(caseId, row.rowIndex, failure.patch);
    CaseList_touchUpdatedAt(caseId);
    return failure.prereq ? { ok: false, prereq: true, taskId: taskId, error: String(err) } : { ok: false, taskId: taskId, error: String(err) };
  } finally {
    ClaudeClient_clearExtraInstruction();
  }
  now = new Date();
  if (ret && ret.skipped === true) {
    var reason = ret.reason || 'スキップ';
    _TaskLedger_writePatch(caseId, row.rowIndex, { status: '未着手', result: '⚠ ' + reason, ranAt: now, updatedAt: now });
    CaseList_touchUpdatedAt(caseId);
    return { skipped: true, reason: reason };
  }
  var links = PanelLinks_collect(ret);
  var url = links.length ? links[0].url : '';
  var result = url ? '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","📄 ' + String(row.taskName).replace(/"/g, '""') + ' の結果を開く")' : String((ret && (ret.panelStatus || ret.panelResult)) || '完了').slice(0, 300);
  _TaskLedger_writePatch(caseId, row.rowIndex, { status: 'AI実行済(要確認)', result: result, ranAt: now, updatedAt: now, failCount: 0 });
  CaseList_touchUpdatedAt(caseId);
  return { ok: true, taskId: taskId, url: url, panelStatus: ret && ret.panelStatus };
}

/* ===== 全案件・全タスク常時自動実行(フェーズ1) ===== */
const TASKLEDGER_PHASE_ORDER = ['common', 'sales', 'p1', 'p2', 'p3', 'onsite', 'after'];
const TASKLEDGER_AUTO_PER_TICK_DEFAULT = 3;
const TASKLEDGER_AUTO_DAILY_CAP_DEFAULT = 80;
const TASKLEDGER_RUNLOG_SHEET = '🤖自動実行ログ';
const TASKLEDGER_RUNLOG_HEADERS = ['日時', '案件ID', '案件名', 'タスク', '機能key', '経路', '結果', 'メッセージ', '所要秒'];
const TASKLEDGER_RUNLOG_MAX = 5000;
const TASKLEDGER_PREREQ_PREFIX = '⏸ 前提待ち: ';
var _TaskLedger_runMeta = null;

function TaskLedger_phaseRank(phase) {
  var i = TASKLEDGER_PHASE_ORDER.indexOf(String(phase || ''));
  return i < 0 ? TASKLEDGER_PHASE_ORDER.length : i;
}

function TaskLedger_isPrereqWaiting(row) {
  return String(row && row.result != null ? row.result : '').indexOf(TASKLEDGER_PREREQ_PREFIX) === 0;
}

/** 前提待ちの行は、直近1時間は再実行しない(毎tick同じ前提エラーを踏まないため)。 */
function _TaskLedger_prereqCoolingDown(row, nowMs) {
  if (!TaskLedger_isPrereqWaiting(row)) return false;
  var at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime();
  if (isNaN(at)) return false;
  return Number(nowMs) - at < 60 * 60 * 1000;
}

/**
 * フェーズゲート。本番前(casePhase!=='after')は after 以外全て可、after は本番終了翌日以降のみ。
 * 同一案件で前フェーズに「未着手(自動実行できるもの)」が残る間は次フェーズを候補にしない。
 * 要人手・不要・完了・お客様担当・失敗3回・前提待ち・送信系は障害にしない。
 */
function TaskLedger_phaseGateAllows(row, rows, casePhase, featureOf) {
  featureOf = featureOf || _TaskLedger_featureByLabel;
  var feature = featureOf(String(row.aiFeature || ''));
  var phase = feature && feature.phase ? feature.phase : '';
  if (!phase) return true;
  if (phase === 'after' && casePhase !== 'after') return false;
  var rank = TaskLedger_phaseRank(phase);
  for (var i = 0; i < (rows || []).length; i++) {
    var other = rows[i];
    if (!other || String(other.taskId) === String(row.taskId)) continue;
    if (other.status !== '未着手' || other.owner === 'お客様' || (Number(other.failCount) || 0) >= 3) continue;
    if (TaskLedger_isPrereqWaiting(other)) continue;
    var f = featureOf(String(other.aiFeature || ''));
    if (!f || !f.phase || !TaskLedger_isAutoRunnable(f)) continue;
    if (TaskLedger_phaseRank(f.phase) < rank) return false;
  }
  return true;
}

function _TaskLedger_isCandidate(row, ctx) {
  var feature = _TaskLedger_featureByLabel(String(row.aiFeature || ''));
  var base = row.status === '未着手' && Boolean(row.aiFeature) && row.owner !== 'お客様' && (Number(row.failCount) || 0) < 3 && TaskLedger_isAutoRunnable(feature);
  if (!base) return false;
  if (!ctx) return true;
  if (_TaskLedger_prereqCoolingDown(row, ctx.nowMs)) return false;
  if (ctx.rows) return TaskLedger_phaseGateAllows(row, ctx.rows, ctx.casePhase, ctx.featureOf);
  return true;
}

/** 案件1件分の自動実行候補(並べ替えキー付き)。info = {startTs, casePhase}。 */
function TaskLedger_buildCandidates(caseId, rows, info, nowMs, featureOf) {
  featureOf = featureOf || _TaskLedger_featureByLabel;
  info = info || {};
  var ctx = { rows: rows, casePhase: info.casePhase || 'p2', nowMs: nowMs, featureOf: featureOf };
  var out = [];
  (rows || []).forEach(function (row) {
    if (row.aiRun === true || !_TaskLedger_isCandidate(row, ctx)) return;
    var feature = featureOf(String(row.aiFeature || '')) || {};
    out.push({
      caseId: caseId, row: row, featureKey: feature.key || '',
      heavy: TaskLedger_heavyFeatureKeys().indexOf(feature.key) >= 0,
      startTs: info.startTs == null || isNaN(info.startTs) ? Number.MAX_SAFE_INTEGER : info.startTs,
      phaseRank: TaskLedger_phaseRank(feature.phase), dueTime: _TaskLedger_dueTime(row.due)
    });
  });
  return out;
}

/** 優先順: 出展開始日が近い順 → フェーズ順 → 期限順 → タスクID。 */
function TaskLedger_compareCandidates(a, b) {
  return (a.startTs - b.startTs) || (a.phaseRank - b.phaseRank) || (a.dueTime - b.dueTime) || String(a.row.taskId).localeCompare(String(b.row.taskId));
}

function TaskLedger_selectAutoTargets(candidates, opts) {
  opts = opts || {};
  var limit = Math.max(0, Number(opts.limit) || 0), perCase = Math.max(1, Number(opts.perCase) || 1), counts = {}, out = [];
  (candidates || []).slice().sort(TaskLedger_compareCandidates).forEach(function (c) {
    if (out.length >= limit || (counts[c.caseId] || 0) >= perCase) return;
    counts[c.caseId] = (counts[c.caseId] || 0) + 1; out.push(c);
  });
  return out;
}

function _TaskLedger_posInt(value, fallback, allowZero) {
  var s = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(s)) return fallback;
  var n = Number(s);
  return n > 0 || (allowZero && n === 0) ? n : fallback;
}

/** Script property の素の値(名前→文字列)から自動実行の設定を作る。未設定・不正値は既定値。 */
function TaskLedger_autoSettingsFrom(props, todayKey) {
  props = props || {};
  return {
    enabled: String(props.TASKLEDGER_AUTO_ENABLED == null ? '' : props.TASKLEDGER_AUTO_ENABLED).trim().toLowerCase() !== 'false',
    perTick: _TaskLedger_posInt(props.TASKLEDGER_AUTO_PER_TICK, TASKLEDGER_AUTO_PER_TICK_DEFAULT, false),
    dailyCap: _TaskLedger_posInt(props.TASKLEDGER_AUTO_DAILY_CAP, TASKLEDGER_AUTO_DAILY_CAP_DEFAULT, true),
    todayCount: _TaskLedger_posInt(props['TASKLEDGER_AUTO_COUNT_' + todayKey], 0, true)
  };
}

/** 停止中は0、それ以外は min(limit, 日次上限の残り)。 */
function TaskLedger_autoRemaining(settings, limit) {
  if (!settings || !settings.enabled) return 0;
  return Math.max(0, Math.min(Number(limit) || 0, settings.dailyCap - settings.todayCount));
}

function _TaskLedger_todayKey() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
}

function _TaskLedger_readAutoSettings() {
  var todayKey = '', props = {};
  try { todayKey = _TaskLedger_todayKey(); } catch (e) {}
  ['TASKLEDGER_AUTO_ENABLED', 'TASKLEDGER_AUTO_PER_TICK', 'TASKLEDGER_AUTO_DAILY_CAP', 'TASKLEDGER_AUTO_COUNT_' + todayKey].forEach(function (name) {
    try { props[name] = PropertiesService.getScriptProperties().getProperty(name); } catch (e) { props[name] = null; }
  });
  var settings = TaskLedger_autoSettingsFrom(props, todayKey);
  settings.todayKey = todayKey;
  return settings;
}

function _TaskLedger_bumpAutoCount(settings) {
  settings.todayCount++;
  try { PropertiesService.getScriptProperties().setProperty('TASKLEDGER_AUTO_COUNT_' + settings.todayKey, String(settings.todayCount)); } catch (e) { console.warn('auto count: ' + e); }
}

/** 前提条件エラーの判定。「先に②見積を」「お客様のメール・議事録がまだありません」など、入力が揃えば通るものは失敗に数えない。 */
function TaskLedger_isPrereqMessage(message) {
  var text = String(message == null ? '' : message);
  return ['先に', 'がまだ', 'まだありません', 'まだ登録されていません', 'が見つかりません', 'が未登録'].some(function (k) { return text.indexOf(k) >= 0; });
}

/** 失敗の扱い。前提条件エラー(TaskLedger_isPrereqMessage)は失敗回数に数えず、未着手のまま「⏸ 前提待ち」を書く。 */
function TaskLedger_failurePatch(failCountBefore, message, now) {
  var text = String(message == null ? '' : message);
  if (TaskLedger_isPrereqMessage(text)) {
    return { prereq: true, patch: { status: '未着手', result: TASKLEDGER_PREREQ_PREFIX + text.replace(/^Error:\s*/, '').slice(0, 280), ranAt: now, updatedAt: now } };
  }
  var failCount = (Number(failCountBefore) || 0) + 1;
  return { prereq: false, failCount: failCount, patch: { status: failCount >= 3 ? '要人手' : '未着手', result: '❌ ' + text.slice(0, 300), ranAt: now, updatedAt: now, failCount: failCount } };
}

function _TaskLedger_resultCell(row, url, text) {
  if (url) return '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","📄 ' + String(row.taskName).replace(/"/g, '""') + ' の結果を開く")';
  return String(text || '完了').slice(0, 300);
}

/** JobQueue 完了時の台帳更新内容。実行中の行だけが対象(人が完了/不要にした行は上書きしない)。 */
function TaskLedger_buildJobResultPatch(row, ok, resultText, url, now) {
  if (!row || row.status !== '実行中') return null;
  if (ok) return { prereq: false, ok: true, patch: { status: 'AI実行済(要確認)', result: _TaskLedger_resultCell(row, url, resultText), ranAt: now, updatedAt: now, failCount: 0 } };
  var plan = TaskLedger_failurePatch(row.failCount, resultText, now);
  plan.ok = false;
  return plan;
}

/** 実行中のまま30分を超えた重い機能(JobQueue 投入分)のタイムアウト更新。該当しなければ null。 */
function TaskLedger_staleHeavyPatch(row, nowMs, featureOf) {
  featureOf = featureOf || _TaskLedger_featureByLabel;
  if (!row || row.status !== '実行中' || !row.ranAt) return null;
  var feature = featureOf(String(row.aiFeature || ''));
  if (!feature || TaskLedger_heavyFeatureKeys().indexOf(feature.key) < 0) return null;
  var at = new Date(row.ranAt).getTime();
  if (isNaN(at) || Number(nowMs) - at <= 30 * 60 * 1000) return null;
  var failCount = (Number(row.failCount) || 0) + 1, now = new Date(nowMs);
  return { status: failCount >= 3 ? '要人手' : '未着手', result: '❌ 前回の実行が時間制限で中断されました(タイムアウト ' + failCount + '回目)', updatedAt: now, failCount: failCount };
}

function TaskLedger_buildRunLogRow(entry, now) {
  entry = entry || {};
  return [now, entry.caseId || '', entry.caseName || '', entry.taskName || '', entry.featureKey || '', entry.route || '', entry.result || '', String(entry.message == null ? '' : entry.message).slice(0, 300), entry.seconds == null ? '' : entry.seconds];
}

/** データ行(ヘッダ除く)が max を超えたとき、2行目から消す行数。 */
function TaskLedger_runLogTrimCount(lastRow, max) {
  return Math.max(0, (Number(lastRow) - 1) - (Number(max) || TASKLEDGER_RUNLOG_MAX));
}

function TaskLedger_appendRunLog(entry) {
  try {
    var ss = SpreadsheetApp.openById(_PANEL_MASTER_SS);
    var sheet = ss.getSheetByName(TASKLEDGER_RUNLOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(TASKLEDGER_RUNLOG_SHEET);
      sheet.getRange(1, 1, 1, TASKLEDGER_RUNLOG_HEADERS.length).setValues([TASKLEDGER_RUNLOG_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    if (!entry.caseName) { try { var c = CaseList_getById(entry.caseId); if (c) entry.caseName = c.clientName + ' / ' + c.caseName; } catch (e) {} }
    sheet.appendRow(TaskLedger_buildRunLogRow(entry, new Date()));
    var trim = TaskLedger_runLogTrimCount(sheet.getLastRow(), TASKLEDGER_RUNLOG_MAX);
    if (trim > 0) sheet.deleteRows(2, trim);
  } catch (e) { console.warn('TaskLedger_appendRunLog: ' + e); }
}

function _TaskLedger_caseInfoMap() {
  var map = {};
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return map;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().forEach(function (r) {
      var id = String(r[0] || '').trim();
      if (id) map[id] = { start: r[3], end: r[4] };
    });
  } catch (e) { console.warn('_TaskLedger_caseInfoMap: ' + e); }
  return map;
}

function _TaskLedger_caseInfoFor(map, caseId, today) {
  var raw = (map && map[caseId]) || {}, t = new Date(raw.start).getTime();
  var phase = 'p2';
  try { if (typeof Panel_phaseKeyFromDates === 'function') phase = Panel_phaseKeyFromDates(raw.start, raw.end, today || new Date()); } catch (e) {}
  return { startTs: raw.start === '' || raw.start == null || isNaN(t) ? NaN : t, casePhase: phase, start: raw.start, end: raw.end };
}

/** 全案件ロールアップ用: 本番日 / 残日数 / 現在フェーズ / 未着手数 / 次に自動実行するタスク名。 */
function TaskLedger_caseRollupInfo(rows, startRaw, endRaw, today, featureOf) {
  var startMs = new Date(startRaw).getTime(), t = today instanceof Date ? today : new Date(today);
  var todayMs = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  var days = '';
  if (startRaw !== '' && startRaw != null && !isNaN(startMs)) { var s = new Date(startMs); days = Math.round((Date.UTC(s.getFullYear(), s.getMonth(), s.getDate()) - todayMs) / 86400000); }
  var phase = 'p2';
  try { if (typeof Panel_phaseKeyFromDates === 'function') phase = Panel_phaseKeyFromDates(startRaw, endRaw, t); } catch (e) {}
  var pending = (rows || []).filter(function (r) { return r.status === '未着手'; }).length;
  var cands = TaskLedger_buildCandidates('', rows, { startTs: 0, casePhase: phase }, t.getTime(), featureOf).sort(TaskLedger_compareCandidates);
  var startLabel = startRaw instanceof Date ? startRaw.getFullYear() + '/' + (startRaw.getMonth() + 1) + '/' + startRaw.getDate() : String(startRaw == null ? '' : startRaw);
  return { startLabel: startLabel, daysLeft: days, phase: phase, pending: pending, next: cands.length ? String(cands[0].row.taskName || '') : '' };
}

/* ----- 新着反映 ----- */
function TaskLedger_planDirty(rows, source, nowLabel, featureOf) {
  featureOf = featureOf || _TaskLedger_featureByLabel;
  var resets = [], skipped = 0;
  (rows || []).forEach(function (row) {
    if (row.status !== 'AI実行済(要確認)') return;
    var feature = featureOf(String(row.aiFeature || ''));
    if (row.owner === 'お客様' || (feature && TaskLedger_sendingFeatureKeys().indexOf(feature.key) >= 0)) { skipped++; return; }
    var old = String(row.result == null ? '' : row.result), tail = old;
    if (old.charAt(0) === '=') { var m = /(https?:\/\/[^"\s,)]+)/.exec(old); tail = m ? m[1] : ''; }
    var head = '📨 新着(' + source + ') ' + nowLabel + ' により再実行待ち';
    resets.push({ rowIndex: row.rowIndex, taskId: row.taskId, patch: { status: '未着手', aiRun: false, result: tail ? head + '\n' + tail : head } });
  });
  return { resets: resets, skipped: skipped };
}

/** 既処理 ref の記録(新しい方を残し、JSON が maxChars に収まるよう古いものから捨てる)。 */
function TaskLedger_dirtyRemember(list, key, maxChars) {
  var out = (list || []).filter(function (k) { return k !== key; }); out.push(key);
  while (out.length > 1 && JSON.stringify(out).length > (maxChars || 8000)) out.shift();
  return out;
}

function _TaskLedger_dirtyKey(caseId, source, ref) { return String(caseId) + '|' + String(source) + '|' + String(ref).slice(0, 60); }

function TaskLedger_markDirty(caseId, source, ref, note) {
  caseId = String(caseId || '').trim(); source = String(source || '').trim() || 'unknown'; ref = String(ref == null ? '' : ref).trim();
  if (!caseId) throw new Error('caseId が必要です');
  var seen = [], key = ref ? _TaskLedger_dirtyKey(caseId, source, ref) : '';
  if (key) {
    try { seen = JSON.parse(PropertiesService.getScriptProperties().getProperty('TASKLEDGER_DIRTY_SEEN') || '[]'); } catch (e) { seen = []; }
    if (seen.indexOf(key) >= 0) return { caseId: caseId, reset: 0, skipped: 0, duplicate: true };
  }
  var started = new Date().getTime();
  var nowLabel = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm');
  var plan = TaskLedger_planDirty(TaskLedger_readRows(caseId).rows, source, nowLabel);
  plan.resets.forEach(function (x) { _TaskLedger_writePatch(caseId, x.rowIndex, Object.assign({}, x.patch, { updatedAt: new Date() })); });
  if (plan.resets.length) CaseList_touchUpdatedAt(caseId);
  if (key) { try { PropertiesService.getScriptProperties().setProperty('TASKLEDGER_DIRTY_SEEN', JSON.stringify(TaskLedger_dirtyRemember(seen, key, 8000))); } catch (e) { console.warn('dirty seen: ' + e); } }
  TaskLedger_appendRunLog({ caseId: caseId, taskName: '(新着反映 ' + plan.resets.length + '件)', route: 'dirty', result: 'ok', message: source + ' ' + ref + (note ? ' / ' + String(note) : ''), seconds: Math.round((new Date().getTime() - started) / 1000) });
  return { caseId: caseId, reset: plan.resets.length, skipped: plan.skipped };
}

/* ----- JobQueue 連携(重い機能) ----- */
function TaskLedger_applyJobResult(job, ok, resultText) {
  var ref = job && job.ledger;
  if (!ref || !ref.caseId || !ref.taskId) return { skipped: true, reason: 'ledger 情報なし' };
  var rows = TaskLedger_readRows(ref.caseId).rows, row = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i].taskId) === String(ref.taskId)) { row = rows[i]; break; }
  var plan = TaskLedger_buildJobResultPatch(row, ok, resultText, job.resultUrl, new Date());
  if (!plan) return { skipped: true, reason: '台帳の行が実行中ではありません' };
  _TaskLedger_writePatch(ref.caseId, row.rowIndex, plan.patch);
  CaseList_touchUpdatedAt(ref.caseId);
  var feature = _TaskLedger_featureByLabel(String(row.aiFeature || '')) || {};
  TaskLedger_appendRunLog({ caseId: ref.caseId, taskName: row.taskName, featureKey: feature.key, route: 'jobqueue', result: plan.ok ? 'ok' : (plan.prereq ? 'prereq' : 'fail'), message: String(resultText || ''), seconds: job.seconds });
  return { ok: plan.ok, taskId: ref.taskId };
}

function _TaskLedger_enqueueHeavy(target, route) {
  var caseId = target.caseId, row = target.row, started = new Date().getTime();
  var feature = _TaskLedger_featureByLabel(String(row.aiFeature || '')) || {};
  try {
    var label = JobQueue_eventLabelForCase(caseId);
    if (!label) throw new Error('実行パネルのイベントラベルを解決できません');
    var enq = (Panel_simulateCheck(feature.label, label, { ledger: { caseId: caseId, taskId: row.taskId } }) || {}).enqueue || {};
    if (enq.duplicate) return { skipped: true, reason: 'すでにジョブキューに投入済みです' };
    var now = new Date();
    _TaskLedger_writePatch(caseId, row.rowIndex, { status: '実行中', ranAt: now, aiRun: false, updatedAt: now, result: '🕒 JobQueue 投入 ' + enq.jobId });
    TaskLedger_appendRunLog({ caseId: caseId, taskName: row.taskName, featureKey: feature.key, route: route, result: 'queued', message: enq.jobId, seconds: Math.round((new Date().getTime() - started) / 1000) });
    return { queued: true, taskId: row.taskId, jobId: enq.jobId };
  } catch (err) {
    var plan = TaskLedger_failurePatch(row.failCount, String(err), new Date());
    try { _TaskLedger_writePatch(caseId, row.rowIndex, plan.patch); } catch (e) {}
    TaskLedger_appendRunLog({ caseId: caseId, taskName: row.taskName, featureKey: feature.key, route: route, result: plan.prereq ? 'prereq' : 'fail', message: String(err), seconds: Math.round((new Date().getTime() - started) / 1000) });
    return { ok: false, taskId: row.taskId, error: String(err) };
  }
}

function _TaskLedger_dispatchAuto(target, route) {
  return target.heavy ? _TaskLedger_enqueueHeavy(target, route) : TaskLedger_runTask(target.caseId, target.row.taskId, { auto: true, route: route });
}

/** 前提不足のメッセージで「要人手」になってしまった行(旧判定の名残)を未着手の前提待ちへ戻す。純関数: 戻す patch か null。 */
function TaskLedger_repairPrereqManualPatch(row, now) {
  if (!row || row.status !== '要人手') return null;
  var text = String(row.result == null ? '' : row.result);
  if (!TaskLedger_isPrereqMessage(text)) return null;
  return { status: '未着手', failCount: 0, result: TASKLEDGER_PREREQ_PREFIX + text.replace(/^❌\s*/, '').replace(/^Error:\s*/, '').slice(0, 280), updatedAt: now };
}

function _TaskLedger_repairPrereqManual(caseId, rows) {
  (rows || []).forEach(function (row) {
    var patch = null;
    try { patch = TaskLedger_repairPrereqManualPatch(row, new Date()); } catch (e) {}
    if (!patch) return;
    _TaskLedger_writePatch(caseId, row.rowIndex, patch);
    row.status = patch.status; row.failCount = patch.failCount; row.result = patch.result; row.updatedAt = patch.updatedAt;
  });
}

function _TaskLedger_releaseStaleHeavy(caseId, rows) {
  var nowMs = new Date().getTime();
  (rows || []).forEach(function (row) {
    var patch = null;
    try { patch = TaskLedger_staleHeavyPatch(row, nowMs); } catch (e) {}
    if (!patch) return;
    _TaskLedger_writePatch(caseId, row.rowIndex, patch);
    row.status = patch.status; row.failCount = patch.failCount; row.result = patch.result; row.updatedAt = patch.updatedAt;
  });
}

function TaskLedger_autoStatus() {
  var settings = _TaskLedger_readAutoSettings(), cases = TaskLedger_activeCaseIds(), infoMap = _TaskLedger_caseInfoMap(), pending = 0, nowMs = new Date().getTime();
  cases.forEach(function (caseId) {
    try { pending += TaskLedger_buildCandidates(caseId, TaskLedger_readRows(caseId).rows, _TaskLedger_caseInfoFor(infoMap, caseId), nowMs).length; }
    catch (e) { console.warn('TaskLedger_autoStatus: ' + caseId + ' / ' + e); }
  });
  return { enabled: settings.enabled, dailyCap: settings.dailyCap, todayCount: settings.todayCount, perTick: settings.perTick, activeCases: cases.length, pendingCandidates: pending, lastTick: _TaskLedger_readCursor('TASKLEDGER_AUTO_LAST_TICK') };
}

function TaskLedger_selectActiveCases(rows, today) {
  var base = today instanceof Date ? today : new Date(today);
  var cutoff = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 30);
  var out = [];
  (rows || []).forEach(function (row) {
    if (out.length >= 30) return;
    var caseId = String(row.caseId != null ? row.caseId : row[0] || '').trim();
    var zissiId = String(row.zissiId != null ? row.zissiId : row[10] || '').trim();
    var rawEnd = row.endDate != null ? row.endDate : row[4];
    if (!caseId || !zissiId) return;
    if (rawEnd !== '' && rawEnd != null) {
      var end = rawEnd instanceof Date ? rawEnd : new Date(rawEnd);
      if (!isNaN(end.getTime()) && end <= cutoff) return;
    }
    out.push(caseId);
  });
  return out;
}

function TaskLedger_activeCaseIds() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return TaskLedger_selectActiveCases(sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(11, sheet.getLastColumn())).getValues(), new Date());
}

function TaskLedger_pollChecked() {
  var started = _TaskLedger_nowMs(), cursorName = 'TASKLEDGER_POLL_CURSOR';
  var cases = _TaskLedger_roundRobinCases(TaskLedger_activeCaseIds(), _TaskLedger_readCursor(cursorName));
  // 新規トリガーを増やせない(上限到達)ため、この巡回に⏳チェック反映を相乗りさせる。
  // 案件ごとではなく全パネル1回の走査で済ませる(案件ごとだと全シート走査を案件数分繰り返す)。
  // 60秒で打ち切り、本来の仕事である ▶AI実行 の予算を残す。
  var pendingApply = null;
  try { pendingApply = PanelPending_applyCheckedAll({ budgetMs: 60000 }); }
  catch (e) { console.warn('PanelPending_applyCheckedAll: ' + e); }
  var checked = [], automatic = [], scanned = 0, lastCase = '', limit = Math.min(8, cases.length), infoMap = _TaskLedger_caseInfoMap(), nowMs = new Date().getTime();
  var seededList = [], seededThisTick = 0;
  try { seededList = JSON.parse(_TaskLedger_readCursor('TASKLEDGER_PANEL_SEEDED') || '[]'); } catch (e) { seededList = []; }
  for (var c = 0; c < limit; c++) {
    // 走査だけで予算を食い潰さない(GAS 6分制限)。残りは cursor で次 tick へ
    if (_TaskLedger_nowMs() - started > 240000) break;
    var caseId = cases[c]; scanned++; lastCase = caseId;
    try {
      var caseRows = TaskLedger_readRows(caseId).rows;
      // 実行パネルの生成機能が台帳に未取込の案件は、夜間(21時)を待たずここで取り込む(1tick最大2案件・残り120秒以上・案件ごと1回だけ)
      var hasPanelRows = caseRows.some(function (r) { return r.source === TASKLEDGER_PANEL_SOURCE; }), seedAttempted = seededList.indexOf(caseId) >= 0;
      if (!hasPanelRows && !seedAttempted && TaskLedger_shouldSeedPanel({ hasPanelRows: false, attempted: false, seededThisTick: seededThisTick, remainingMs: 240000 - (_TaskLedger_nowMs() - started) })) {
        seededThisTick++;
        seededList = TaskLedger_dirtyRemember(seededList, caseId, 4000);
        try { _TaskLedger_writeCursor('TASKLEDGER_PANEL_SEEDED', JSON.stringify(seededList)); } catch (e) {}
        try { TaskLedger_sync(caseId); caseRows = TaskLedger_readRows(caseId).rows; }
        catch (e) { console.warn('TaskLedger_pollChecked seed: ' + caseId + ' / ' + e); }
      }
      caseRows.forEach(function (row) { if (row.aiRun === true) checked.push({ caseId: caseId, taskId: row.taskId }); });
      _TaskLedger_releaseStaleHeavy(caseId, caseRows);
      _TaskLedger_repairPrereqManual(caseId, caseRows);
      automatic = automatic.concat(TaskLedger_buildCandidates(caseId, caseRows, _TaskLedger_caseInfoFor(infoMap, caseId), nowMs));
    }
    catch (e) { console.warn('TaskLedger_pollChecked: ' + caseId + ' / ' + e); }
  }
  if (lastCase) _TaskLedger_writeCursor(cursorName, lastCase);
  var results = [], ran = 0, autoRan = 0;
  for (var i = 0; i < checked.length && i < 1; i++) {
    if (_TaskLedger_nowMs() - started > 240000) break;
    results.push(TaskLedger_runTask(checked[i].caseId, checked[i].taskId, { auto: false, route: 'checked' })); ran++;
  }
  // 時間帯を問わず自動候補を実行する。1tick の予算は240秒、1件開始前に残りが60秒未満なら打ち切る。
  var settings = _TaskLedger_readAutoSettings();
  var targets = TaskLedger_selectAutoTargets(automatic, { limit: TaskLedger_autoRemaining(settings, settings.perTick), perCase: 1 });
  var elapsedBeforeAuto = Math.round((_TaskLedger_nowMs() - started) / 1000), budgetHit = false;
  // 計画行: 生成中に 6 分制限で落ちても「何を実行しようとしたか」が残る
  if (targets.length) {
    try { TaskLedger_appendRunLog({ caseId: '', caseName: '-', taskName: '(tick-plan)', route: 'tick', result: 'plan', message: 'candidates=' + automatic.length + ' targets=' + targets.map(function (t) { return t.caseId + ':' + String(t.row.taskName || '').slice(0, 20); }).join(', ') + ' elapsed=' + elapsedBeforeAuto + 's', seconds: elapsedBeforeAuto }); } catch (e) {}
  }
  for (var k = 0; k < targets.length; k++) {
    // 1本の生成は数分かかり得るため、予算ゲートで打ち切る
    // Workspace のトリガーは1実行30分まで動ける(18:12 の tick が 774 秒で完走した実測)。10分間隔との重複を避けつつ 1本目は経過420秒、2本目以降は300秒以内
    if (_TaskLedger_nowMs() - started > (k === 0 ? 420000 : 300000)) { budgetHit = true; break; }
    _TaskLedger_bumpAutoCount(settings);
    results.push(_TaskLedger_dispatchAuto(targets[k], 'auto')); autoRan++;
  }
  try { _TaskLedger_writeCursor('TASKLEDGER_AUTO_LAST_TICK', new Date().toISOString()); } catch (e) {}
  // 観測行: 候補ゼロなのか予算切れなのかをログだけで判定できるようにする
  try {
    TaskLedger_appendRunLog({ caseId: '', caseName: '-', taskName: '(tick)', route: 'tick', result: autoRan ? 'ok' : (budgetHit ? 'budget' : (targets.length ? 'skip' : 'idle')),
      message: 'scanned=' + scanned + ' checked=' + checked.length + ' candidates=' + automatic.length + ' targets=' + targets.length + ' autoRan=' + autoRan + ' seeded=' + seededThisTick + ' enabled=' + settings.enabled + ' today=' + settings.todayCount + '/' + settings.dailyCap + ' elapsedBeforeAuto=' + elapsedBeforeAuto + 's',
      seconds: Math.round((_TaskLedger_nowMs() - started) / 1000) });
  } catch (e) { console.warn('tick log: ' + e); }
  return { scannedCases: scanned, cursor: lastCase, checked: checked.length, ran: ran, autoRan: autoRan, autoCandidates: automatic.length, autoEnabled: settings.enabled, results: results, pendingApply: pendingApply };
}

function _TaskLedger_dueTime(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  var d = new Date(value);
  return value && !isNaN(d.getTime()) ? d.getTime() : Number.MAX_SAFE_INTEGER;
}

function TaskLedger_selectNightlyCandidates(items) {
  var counts = {}, selected = [];
  (items || []).sort(function (a, b) { return _TaskLedger_dueTime(a.row.due) - _TaskLedger_dueTime(b.row.due) || String(a.row.taskId).localeCompare(String(b.row.taskId)); }).forEach(function (item) {
    if (selected.length >= 15 || (counts[item.caseId] || 0) >= 3) return;
    counts[item.caseId] = (counts[item.caseId] || 0) + 1; selected.push(item);
  });
  return selected;
}

function TaskLedger_syncAllNightly() {
  var started = _TaskLedger_nowMs(), cursorName = 'TASKLEDGER_SYNC_CURSOR';
  var cases = _TaskLedger_roundRobinCases(TaskLedger_activeCaseIds(), _TaskLedger_readCursor(cursorName));
  var synced = 0, errors = [], truncated = false, lastCase = '';
  var reviewNag = null;
  try { reviewNag = PrintChecklist_nagPendingReview(cases); }
  catch (e) { errors.push('印刷物チェック通知: ' + e.message); }
  for (var i = 0; i < cases.length; i++) {
    if (_TaskLedger_nowMs() - started > 300000) { truncated = true; break; }
    lastCase = cases[i];
    try { TaskLedger_sync(cases[i]); synced++; }
    catch (e) { errors.push(cases[i] + ': ' + e); }
  }
  if (lastCase) _TaskLedger_writeCursor(cursorName, lastCase);
  console.log('sync 対象' + cases.length + '件 / 完了' + synced + '件 / 打ち切り: ' + truncated);
  return { cases: cases.length, synced: synced, truncated: truncated, cursor: lastCase, errors: errors, reviewNag: reviewNag };
}

function TaskLedger_autoRunNightly() {
  var started = _TaskLedger_nowMs(), cases = TaskLedger_activeCaseIds(), errors = [], candidates = [], infoMap = _TaskLedger_caseInfoMap(), nowMs = new Date().getTime();
  cases.forEach(function (caseId) {
    try {
      var caseRows = TaskLedger_readRows(caseId).rows;
      _TaskLedger_releaseStaleHeavy(caseId, caseRows);
      candidates = candidates.concat(TaskLedger_buildCandidates(caseId, caseRows, _TaskLedger_caseInfoFor(infoMap, caseId), nowMs));
    } catch (e) { errors.push(caseId + ': ' + e); }
  });
  var settings = _TaskLedger_readAutoSettings();
  var selected = TaskLedger_selectAutoTargets(candidates, { limit: TaskLedger_autoRemaining(settings, 6), perCase: 3 });
  var results = [], truncated = candidates.length > selected.length, reason = candidates.length > selected.length ? (settings.enabled ? '最大6件/日次上限' : '自動実行停止中') : '';
  for (var i = 0; i < selected.length; i++) {
    if (_TaskLedger_nowMs() - started > 220000) { truncated = true; reason = '経過280秒枠(残60秒未満)'; break; }
    _TaskLedger_bumpAutoCount(settings);
    results.push(_TaskLedger_dispatchAuto(selected[i], 'nightly'));
  }
  var ok = 0, failed = 0, skipped = 0;
  results.forEach(function (r) { if (r.ok || r.queued) ok++; else if (r.skipped) skipped++; else failed++; });
  console.log('候補' + candidates.length + '件 / 実行' + results.length + '件 / 打ち切り: ' + truncated + (reason ? ' (' + reason + ')' : ''));
  return { cases: cases.length, candidates: candidates.length, ran: results.length, ok: ok, failed: failed, skipped: skipped, truncated: truncated, errors: errors };
}

function TaskLedger_panelSummaryValue(caseId) {
  try {
    var read = TaskLedger_readRows(caseId);
    if (!read.sheetUrl) throw new Error('missing');
    var s = TaskLedger_summarize(read.rows, new Date());
    var pr = PrintChecklist_pendingReviewCount(caseId);
    var printStatus = pr.found ? ' ／ 印刷物の仕分け待ち ' + pr.count + '件（B列を未入稿／入稿済／対象外にする）' : '';
    return '=HYPERLINK("' + read.sheetUrl.replace(/"/g, '""') + '","🧭 残タスク ' + s.open + '件 ／ 期限切れ ' + s.overdue + '件 ／ 要確認 ' + s.needsReview + '件' + printStatus + ' — クリックで台帳を開く")';
  } catch (e) { return '🧭 タスク台帳はまだありません — 上の「🧭 残タスクを洗い出して台帳を更新」を実行してください'; }
}

function TaskLedger_rebuildRollup() {
  var ss = SpreadsheetApp.getActive(), name = '🧭タスク台帳(全案件)', sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  var cases = TaskLedger_activeCaseIds(), allOpen = [], rollupInfo = {}, today = new Date(); today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cases.forEach(function (caseId) {
    try {
      var c = CaseList_getById(caseId) || { caseId: caseId, clientName: '', caseName: '' };
      var read = TaskLedger_readRows(caseId);
      try { var ri = TaskLedger_caseRollupInfo(read.rows, c.startDate, c.endDate, today); rollupInfo[caseId] = [ri.startLabel, ri.daysLeft, ri.phase, ri.pending, ri.next]; } catch (e) { rollupInfo[caseId] = ['', '', '', '', '']; }
      read.rows.forEach(function (row) { if (row.status !== '完了' && row.status !== '不要') allOpen.push({ caseId: caseId, c: c, row: row, sheetUrl: read.sheetUrl, dueTime: _TaskLedger_dueTime(row.due) }); });
    }
    catch (e) { console.warn('TaskLedger_rebuildRollup: ' + caseId + ' / ' + e); }
  });
  allOpen.sort(function (a, b) { return a.dueTime - b.dueTime || a.c.clientName.localeCompare(b.c.clientName) || String(a.row.taskId).localeCompare(String(b.row.taskId)); });
  var overdue = 0, needsReview = 0, masterOpen = 0, masterByCase = {}, eligibleByCase = {};
  allOpen.forEach(function (x) {
    if (x.dueTime < today.getTime()) overdue++;
    if (x.row.status === 'AI実行済(要確認)') needsReview++;
    if (x.row.source === 'master工程') { masterOpen++; masterByCase[x.caseId] = (masterByCase[x.caseId] || 0) + 1; }
    else eligibleByCase[x.caseId] = (eligibleByCase[x.caseId] || 0) + 1;
  });
  var shownByCase = {}, rows = [];
  allOpen.forEach(function (x) {
    if (x.row.source === 'master工程' || (shownByCase[x.caseId] || 0) >= 20) return;
    shownByCase[x.caseId] = (shownByCase[x.caseId] || 0) + 1;
    rows.push(x);
  });
  var lastIndexByCase = {};
  rows.forEach(function (x, i) { lastIndexByCase[x.caseId] = i; });
  var displayRows = [];
  rows.forEach(function (x, i) {
    displayRows.push(x);
    var hidden = (eligibleByCase[x.caseId] || 0) - (shownByCase[x.caseId] || 0);
    if (hidden > 0 && lastIndexByCase[x.caseId] === i) displayRows.push({ caseId: x.caseId, c: x.c, sheetUrl: x.sheetUrl, overflow: hidden });
  });
  sheet.getRange('A1').setValue('🧭 全案件の残タスク').setFontWeight('bold').setFontSize(14);
  sheet.getRange('B1').setValue(new Date()); sheet.getRange('E1').setValue('表示 ' + rows.length + '件 / 残り全体 ' + allOpen.length + '件(うちmaster工程 ' + masterOpen + '件) / 期限切れ ' + overdue + '件 / 要確認 ' + needsReview + '件').setFontWeight('bold');
  sheet.getRange('A2:K2').breakApart();
  sheet.getRange('A2:K2').merge().setValue('状態と修正指示の編集は各案件の実施計画書「Claude_タスク台帳」で行ってください（このシートは毎晩22時に作り直される一覧です）').setFontSize(9).setFontColor('#757575').setWrap(true);
  sheet.getRange(3, 1, 1, 16).setValues([['期限', '状態', 'クライアント', '案件名', 'タスク', '発生源', '担当', 'AI機能', '結果', 'master工程の残', '台帳を開く', '本番日', '残日数', '現在フェーズ', '未着手数', '次に自動実行するタスク']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  if (!rows.length) sheet.getRange(4, 1).setValue('残タスクはありません');
  else {
    var values = displayRows.map(function (x) {
      if (x.overflow) return ['', '', x.c.clientName, x.c.caseName, '… 他 ' + x.overflow + ' 件は案件の台帳で', '', '', '', '', masterByCase[x.caseId] || 0, '=HYPERLINK("' + x.sheetUrl + '","🧭 台帳")'].concat(rollupInfo[x.caseId] || ['', '', '', '', '']);
      var result = String(x.row.result || '');
      var urlMatch = /(https?:\/\/[^"\s,)]+)/.exec(result);
      if (urlMatch) result = '=HYPERLINK("' + urlMatch[1].replace(/"/g, '""') + '","📄 開く")';
      return [x.row.due, x.row.status, x.c.clientName, x.c.caseName, x.row.taskName, x.row.source, x.row.owner, x.row.aiFeature, result, masterByCase[x.caseId] || 0, '=HYPERLINK("' + x.sheetUrl + '","🧭 台帳")'].concat(rollupInfo[x.caseId] || ['', '', '', '', '']);
    });
    sheet.getRange(4, 1, values.length, 16).setValues(values);
    displayRows.forEach(function (x, i) { if (!x.overflow && x.row.status === 'AI実行済(要確認)') sheet.getRange(i + 4, 1, 1, 11).setBackground('#e8f5e9'); else if (!x.overflow && x.dueTime < today.getTime()) sheet.getRange(i + 4, 1, 1, 11).setBackground('#fce4ec'); });
  }
  sheet.setFrozenRows(3); [90,130,160,240,300,110,90,220,220,120,90,90,70,90,80,240].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  return { sheetUrl: PanelLinks_sheetUrl(ss, sheet), cases: cases.length, rows: rows.length, open: allOpen.length, overdue: overdue, needsReview: needsReview };
}

function _TaskLedger_purgePlan(rows, source) {
  var deletions = [], kept = [];
  (rows || []).forEach(function (row) {
    if (String(row.source || '') !== String(source || '')) return;
    var reasons = [];
    if (row.status !== '未着手') reasons.push('状態=' + String(row.status || '(空)'));
    if (String(row.result || '').trim()) reasons.push('実行結果あり');
    if (String(row.revision || '').trim()) reasons.push('修正指示あり');
    if (reasons.length) kept.push({ rowIndex: row.rowIndex, taskId: row.taskId, reasons: reasons });
    else deletions.push(row.rowIndex);
  });
  deletions.sort(function (a, b) { return b - a; });
  return { deletions: deletions, kept: kept };
}

function _TaskLedger_deleteRanges(descendingRowIndexes) {
  var indexes = [], seen = {};
  (descendingRowIndexes || []).forEach(function (rowIndex) {
    var value = Number(rowIndex);
    if (!seen[value]) {
      seen[value] = true;
      indexes.push(value);
    }
  });
  indexes.sort(function (a, b) { return b - a; });
  var ranges = [];
  indexes.forEach(function (rowIndex) {
    var last = ranges.length ? ranges[ranges.length - 1] : null;
    if (last && rowIndex === last.start - 1) {
      last.start = rowIndex;
      last.count++;
    } else {
      ranges.push({ start: rowIndex, count: 1 });
    }
  });
  return ranges;
}

/** A列の値配列(2行目以降)から、消すべき連続区間を [{start, count}] で返す(行番号は実シートの絶対行、start降順=下から消せる順) */
function TaskLedger_blankRanges(columnAValues, firstDataRow) {
  var blankRows = [];
  (columnAValues || []).forEach(function (row, i) {
    var value = Array.isArray(row) ? row[0] : row;
    if (String(value == null ? '' : value).trim() === '') blankRows.push(firstDataRow + i);
  });
  return _TaskLedger_deleteRanges(blankRows);
}

/**
 * 台帳の「taskId が空の行」を削除して詰める。既に空いてしまった巨大な空白域を直す admin コマンド
 * (C0038 で getLastRow=1132 のうち約1000行が空になった事故の復旧用、2026-09-03 追加)。
 * @param {string} caseId
 * @param {{dryRun?: boolean, budgetMs?: number}} opts
 */
function _admin_taskLedgerCompact(caseId, opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var budgetMs = opts.budgetMs || 240000;
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var zissiSs = _Zissi_open(c);
  var sheet = zissiSs.getSheetByName(TASK_LEDGER_SHEET_NAME);
  if (!sheet) return { error: '台帳がありません' };
  var sheetUrl = PanelLinks_sheetUrl(zissiSs, sheet);
  var lastRow = sheet.getLastRow();
  var taskRowsBefore = _TaskLedger_rowsFromSheet(sheet).length;
  var ranges = lastRow >= 2 ? TaskLedger_blankRanges(sheet.getRange(2, 1, lastRow - 1, 1).getValues(), 2) : [];
  var blankRowsFound = ranges.reduce(function (sum, r) { return sum + r.count; }, 0);
  var result = {
    caseId: caseId, dryRun: dryRun, sheetUrl: sheetUrl,
    taskRowsBefore: taskRowsBefore, taskRowsAfter: taskRowsBefore,
    blankRowsFound: blankRowsFound, deletedRows: 0, ranges: ranges,
    lastRowBefore: lastRow, lastRowAfter: lastRow, partial: false, remaining: blankRowsFound
  };
  if (dryRun || !ranges.length) return result;
  var filter = sheet.getFilter();
  if (filter) filter.remove();
  var startedAt = _TaskLedger_nowMs();
  var applied = [];
  var deleted = 0;
  var partial = false;
  try {
    for (var i = 0; i < ranges.length; i++) {
      if (_TaskLedger_nowMs() - startedAt > budgetMs) { partial = true; break; }
      var range = ranges[i];
      sheet.deleteRows(range.start, range.count);
      applied.push(range);
      deleted += range.count;
    }
    SpreadsheetApp.flush();
  } finally {
    try { sheet.getRange(1, 1, 1, 15).createFilter(); } catch (e) {}
  }
  var taskRowsAfter = _TaskLedger_rowsFromSheet(sheet).length;
  if (taskRowsAfter < taskRowsBefore) throw new Error('タスク台帳の詰め直しでタスクが減りました（' + taskRowsBefore + ' → ' + taskRowsAfter + '）。中断します');
  result.deletedRows = deleted;
  result.ranges = applied;
  result.taskRowsAfter = taskRowsAfter;
  result.lastRowAfter = sheet.getLastRow();
  result.partial = partial;
  result.remaining = blankRowsFound - deleted;
  // 行を詰めるとパネル ⏳ のリンク(&range=A<行>)が古い行番号を指したままになるので必ず作り直す
  try { result.panelRefreshed = PanelPending_refresh(caseId).pendingCount; }
  catch (e) { result.panelRefreshError = String(e); }
  return result;
}

/**
 * 全案件の台帳の空白域を一括で調べる/詰める。既定は dryRun。
 * 1案件ずつコマンドを投げると往復が多すぎるため (2026-09-03 の復旧作業で18案件分必要になった)。
 */
function _admin_taskLedgerCompactAll(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var budgetMs = Number(opts.budgetMs) || 240000;
  var startedAt = _TaskLedger_nowMs();
  var cases = TaskLedger_activeCaseIds();
  var rows = [], truncated = false, totalBlank = 0, totalDeleted = 0;
  for (var i = 0; i < cases.length; i++) {
    if (_TaskLedger_nowMs() - startedAt > budgetMs) { truncated = true; break; }
    var caseId = cases[i];
    try {
      // 個別版はパネル再構築まで走って重いので、dryRun の調査では呼ばない
      var r = _admin_taskLedgerCompact(caseId, { dryRun: dryRun, budgetMs: 60000 });
      if (r.error) { rows.push({ caseId: caseId, error: r.error }); continue; }
      totalBlank += r.blankRowsFound || 0;
      totalDeleted += r.deletedRows || 0;
      if ((r.blankRowsFound || 0) > 0) {
        rows.push({ caseId: caseId, blankRowsFound: r.blankRowsFound, deletedRows: r.deletedRows,
          taskRowsBefore: r.taskRowsBefore, taskRowsAfter: r.taskRowsAfter,
          lastRowBefore: r.lastRowBefore, lastRowAfter: r.lastRowAfter });
      }
    } catch (e) { rows.push({ caseId: caseId, error: String(e) }); }
  }
  return { dryRun: dryRun, scanned: i, cases: cases.length,
    totalBlankRows: totalBlank, totalDeletedRows: totalDeleted, truncated: truncated, needsCompaction: rows };
}

function _admin_taskLedgerPurgeSource(caseId, source, opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var sheet = _Zissi_open(c).getSheetByName(TASK_LEDGER_SHEET_NAME);
  if (!sheet) return { willDelete: 0, deleted: 0, ranges: [], kept: [], remaining: 0, truncated: false, dryRun: dryRun };
  var plan = _TaskLedger_purgePlan(_TaskLedger_rowsFromSheet(sheet), source);
  var plannedRanges = _TaskLedger_deleteRanges(plan.deletions);
  var appliedRanges = [];
  var deleted = 0;
  var truncated = false;
  if (!dryRun) {
    var startedAt = _TaskLedger_nowMs();
    for (var i = 0; i < plannedRanges.length; i++) {
      if (_TaskLedger_nowMs() - startedAt > 240000) {
        truncated = true;
        break;
      }
      var range = plannedRanges[i];
      sheet.deleteRows(range.start, range.count);
      appliedRanges.push(range);
      deleted += range.count;
    }
    SpreadsheetApp.flush();
  }
  var remaining = _TaskLedger_rowsFromSheet(sheet).filter(function (row) { return String(row.source || '') === String(source || ''); }).length;
  return { willDelete: plan.deletions.length, deleted: deleted, ranges: dryRun ? plannedRanges : appliedRanges, kept: plan.kept, remaining: remaining, truncated: truncated, dryRun: dryRun };
}

/**
 * 台帳の AI機能 ラベルが実行パネルの定義と一致しているかを読み取り専用で確認する。
 * 4バイト絵文字(📮/🧭 等)が経路のどこかで壊れると runTask が毎回 skip になるため、
 * 実行せずに一致だけを検証できる口を残す (2026-09-02 の検証で必要になった)。
 */
/**
 * 台帳の1行の 状態 / 修正指示 を管理者が直す。
 * 生成が GAS の時間制限で殺されて 実行中 のまま残った行の復旧と、
 * 修正指示を入れて再実行させる運用のための最小の口 (2026-09-02 追加)。
 * 実行結果 と 失敗回数 はここでは触らない。
 */
function _admin_taskLedgerSetRow(caseId, taskId, patch) {
  patch = patch || {};
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var sheet = _Zissi_open(c).getSheetByName(TASK_LEDGER_SHEET_NAME);
  if (!sheet) throw new Error('タスク台帳がありません: ' + caseId);
  var target = null;
  _TaskLedger_rowsFromSheet(sheet).forEach(function (row) {
    if (String(row.taskId) === String(taskId)) target = row;
  });
  if (!target) throw new Error('タスクが見つかりません: ' + taskId);
  if (patch.status !== undefined) {
    if (TASK_LEDGER_STATUSES.indexOf(String(patch.status)) < 0) throw new Error('不正な状態: ' + patch.status);
    sheet.getRange(target.rowIndex, 2).setValue(String(patch.status));
  }
  if (patch.revision !== undefined) sheet.getRange(target.rowIndex, 13).setValue(String(patch.revision));
  if (patch.aiRun !== undefined) sheet.getRange(target.rowIndex, 3).setValue(patch.aiRun === true);
  sheet.getRange(target.rowIndex, 15).setValue(new Date());
  SpreadsheetApp.flush();
  // read-back verify (setValue は validation 違反等で silent ignore されるため)
  var after = sheet.getRange(target.rowIndex, 1, 1, 17).getValues()[0];
  return { taskId: taskId, rowIndex: target.rowIndex, status: String(after[1] || ''), aiRun: after[2], revision: String(after[12] || '') };
}

function _debug_taskLedgerFeature(caseId, taskId) {
  var read = TaskLedger_readRows(caseId);
  var out = [];
  read.rows.forEach(function (row) {
    if (taskId && String(row.taskId) !== String(taskId)) return;
    if (!taskId && !String(row.aiFeature || '').trim()) return;
    var feature = _TaskLedger_featureByLabel(String(row.aiFeature || ''));
    out.push({
      taskId: row.taskId, source: row.source, status: row.status,
      aiFeatureCodePoints: Array.prototype.map.call(String(row.aiFeature || '').slice(0, 3), function (ch) { return ch.codePointAt(0); }),
      matched: Boolean(feature), featureKey: feature ? feature.key : '',
      command: feature ? feature.command : '',
      autoRunnable: feature ? TaskLedger_isAutoRunnable(feature) : false
    });
  });
  return { sheetUrl: read.sheetUrl, checked: out.length, rows: out };
}

function _debug_taskLedger(caseId) {
  const read = TaskLedger_readRows(caseId);
  return { sheetUrl: read.sheetUrl, rows: read.rows, summary: TaskLedger_summarize(read.rows, new Date()) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TaskLedger_normalizeKeyPart: TaskLedger_normalizeKeyPart, TaskLedger_makeKey: TaskLedger_makeKey, TaskLedger_nextTaskId: TaskLedger_nextTaskId, TaskLedger_mergePlan: TaskLedger_mergePlan, TaskLedger_summarize: TaskLedger_summarize, TaskLedger_isAutoRunnable: TaskLedger_isAutoRunnable, TaskLedger_selectActiveCases: TaskLedger_selectActiveCases, TaskLedger_selectNightlyCandidates: TaskLedger_selectNightlyCandidates, TaskLedger_normalizeFeatureLabel: TaskLedger_normalizeFeatureLabel, TaskLedger_lastTaskRowFromValues: TaskLedger_lastTaskRowFromValues, TaskLedger_blankRanges: TaskLedger_blankRanges, _TaskLedger_purgePlan: _TaskLedger_purgePlan, _TaskLedger_deleteRanges: _TaskLedger_deleteRanges, TaskLedger_phaseRank: TaskLedger_phaseRank, TaskLedger_phaseGateAllows: TaskLedger_phaseGateAllows, TaskLedger_buildCandidates: TaskLedger_buildCandidates, TaskLedger_compareCandidates: TaskLedger_compareCandidates, TaskLedger_selectAutoTargets: TaskLedger_selectAutoTargets, TaskLedger_autoSettingsFrom: TaskLedger_autoSettingsFrom, TaskLedger_autoRemaining: TaskLedger_autoRemaining, TaskLedger_failurePatch: TaskLedger_failurePatch, TaskLedger_buildJobResultPatch: TaskLedger_buildJobResultPatch, TaskLedger_staleHeavyPatch: TaskLedger_staleHeavyPatch, TaskLedger_buildRunLogRow: TaskLedger_buildRunLogRow, TaskLedger_runLogTrimCount: TaskLedger_runLogTrimCount, TaskLedger_caseRollupInfo: TaskLedger_caseRollupInfo, TaskLedger_planDirty: TaskLedger_planDirty, TaskLedger_dirtyRemember: TaskLedger_dirtyRemember, TaskLedger_heavyFeatureKeys: TaskLedger_heavyFeatureKeys, TaskLedger_sendingFeatureKeys: TaskLedger_sendingFeatureKeys, TaskLedger_isPrereqWaiting: TaskLedger_isPrereqWaiting, TaskLedger_isPrereqMessage: TaskLedger_isPrereqMessage, TaskLedger_repairPrereqManualPatch: TaskLedger_repairPrereqManualPatch, _TaskLedger_isCandidate: _TaskLedger_isCandidate, _TaskLedger_dispatchAuto: _TaskLedger_dispatchAuto, _TaskLedger_enqueueHeavy: _TaskLedger_enqueueHeavy, _TaskLedger_dirtyKey: _TaskLedger_dirtyKey, TASKLEDGER_PHASE_ORDER: TASKLEDGER_PHASE_ORDER, TASKLEDGER_PREREQ_PREFIX: TASKLEDGER_PREREQ_PREFIX, TaskLedger_panelDueDate: TaskLedger_panelDueDate, TaskLedger_panelSeedItems: TaskLedger_panelSeedItems, TaskLedger_panelSeedExcludedKeys: TaskLedger_panelSeedExcludedKeys, TaskLedger_shouldSeedPanel: TaskLedger_shouldSeedPanel };

/** startDate が不正なら期限を作らない（Date の翌月への繰り上げを拒否）。 */
function TaskLedger_printReviewDue(startDate) {
  var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(startDate || '').trim());
  if (!m) return '';
  var date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCFullYear() !== Number(m[1]) || date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) return '';
  date.setUTCDate(date.getUTCDate() - 21);
  return date.getUTCFullYear() + '/' + ('0' + (date.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + date.getUTCDate()).slice(-2);
}

/** row8を全案件分まとめて10分キャッシュ。担当者マスタは新設しない。 */
function TaskLedger_producerName(c) {
  if (!c || !Number(c.masterCol)) return 'オージャスト';
  try {
    var cache = null, names = null;
    try { cache = CacheService.getScriptCache(); names = JSON.parse(cache.get('taskLedger:producers:v1') || 'null'); } catch (e) {}
    if (!names) {
      var sheet = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI').getSheetByName('task');
      var values = sheet.getRange(8, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
      names = {};
      values.forEach(function (value, i) {
        var name = String(value || '').replace(/^\s*制作P\s*[：:]\s*/, '').trim()
          .replace(/^P(?=[\s：:ぁ-んァ-ヶ一-龠])[\s：:]*/, '').trim();
        if (name && name.charAt(0) !== '#') names[i + 1] = name;
      });
      try { if (cache) cache.put('taskLedger:producers:v1', JSON.stringify(names), 600); } catch (e) {}
    }
    return names[Number(c.masterCol)] || 'オージャスト';
  } catch (e) { return 'オージャスト'; }
}
