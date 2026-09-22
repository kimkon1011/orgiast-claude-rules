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

function TaskLedger_makeKey(source, taskName) {
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
    const key = TaskLedger_makeKey(item.source, item.taskName);
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
      [['detail', '内容'], ['evidence', '根拠'], ['due', '期限'], ['owner', '担当'], ['aiFeature', 'AI機能']].forEach(function (pair) {
        var refreshable = item.refresh === true && (pair[0] === 'detail' || pair[0] === 'evidence');
        if (refreshable || (String(row[pair[0]] == null ? '' : row[pair[0]]) === '' && String(item[pair[0]] == null ? '' : item[pair[0]]) !== '')) patch[pair[1]] = item[pair[0]] == null ? '' : item[pair[0]];
      });
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
      source: '印刷物チェック', taskName: '印刷物チェックシートの棚卸し（不要な行を対象外にする）',
      detail: ('未確認 ' + pr.count + '件。印刷会社様に見えているので、印刷しないもの・重複・古い行は Z列「社内確認(PD)」を「対象外」に、印刷するものは「確認済」にする。').slice(0, 200),
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
  return { items: items, errors: errors };
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
      const rows = plan.appends.map(function (entry) { const x = entry.item; return [entry.taskId, '未着手', false, x.taskName || '', x.detail || '', x.source || '', x.evidence || '', x.due || '', x.owner || '', x.aiFeature || '', '', '', '', now, now, TaskLedger_makeKey(x.source, x.taskName), 0]; });
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
    return { added: plan.stats.added, updated: plan.stats.updated, autoCompleted: plan.stats.autoCompleted, reopened: plan.stats.reopened, skipped: plan.stats.skipped, sheetUrl: sheetUrl, taskIds: plan.appends.map(function (x) { return x.taskId; }) };
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
  const read = TaskLedger_readRows(caseId);
  const summary = TaskLedger_summarize(read.rows, new Date());
  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'タスク台帳', '残' + summary.open + '件 / 期限切れ' + summary.overdue + '件 / 新規' + result.added + '件', result.sheetUrl);
  return { sheetUrl: result.sheetUrl, sheetName: TASK_LEDGER_SHEET_NAME, added: result.added, updated: result.updated, autoCompleted: result.autoCompleted, reopened: result.reopened, open: summary.open, overdue: summary.overdue, needsReview: summary.needsReview, errors: collected.errors, panelStatus: '✅ 残タスク ' + summary.open + '件 (期限切れ ' + summary.overdue + '件 / 新規 ' + result.added + '件 / 再オープン ' + result.reopened + '件)' };
}

function TaskLedger_sendingFeatureKeys() {
  return ['assignRequest', 'procurementSubmit', 'procurementQuick'];
}

/**
 * 6分制限に当たりやすい重い生成。台帳からは実行せず、実行パネル(JobQueue = 1起動1ジョブ)経由で人が回す。
 * 判定基準: 出展マニュアル/図面などの PDF を documents として Claude に添付する機能は
 * ほぼ確実に 6 分に収まらない。2026-09-02 の実測で layoutPlan / logisticsPlan / submission が中断された
 * (submission は初回 5分45秒でギリギリ完走したが、修正指示を足した2回目で超過)。
 * 新しい機能を台帳から回す前に、まずここに入れるべきかを実測で判断すること。
 */
function TaskLedger_heavyFeatureKeys() {
  return ['layoutPlan', 'logisticsPlan', 'submission', 'constructionManual', 'operationsPlan', 'setupTeardown', 'proofCheck', 'nyukoCheck'];
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

function _TaskLedger_isCandidate(row) {
  var feature = _TaskLedger_featureByLabel(String(row.aiFeature || ''));
  return row.status === '未着手' && Boolean(row.aiFeature) && row.owner !== 'お客様' && (Number(row.failCount) || 0) < 3 && TaskLedger_isAutoRunnable(feature) && TaskLedger_heavyFeatureKeys().indexOf(feature.key) < 0;
}

function _TaskLedger_writePatch(caseId, rowIndex, patch) {
  var c = CaseList_getById(caseId);
  var sheet = _Zissi_open(c).getSheetByName(TASK_LEDGER_SHEET_NAME);
  var columns = { status: 2, aiRun: 3, result: 11, ranAt: 12, updatedAt: 15, failCount: 17 };
  Object.keys(patch).forEach(function (key) { sheet.getRange(rowIndex, columns[key]).setValue(patch[key]); });
}

function TaskLedger_runTask(caseId, taskId, opts) {
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
    var failCount = (Number(row.failCount) || 0) + 1;
    now = new Date();
    _TaskLedger_writePatch(caseId, row.rowIndex, { status: failCount >= 3 ? '要人手' : '未着手', result: '❌ ' + String(err).slice(0, 300), ranAt: now, updatedAt: now, failCount: failCount });
    CaseList_touchUpdatedAt(caseId);
    return { ok: false, taskId: taskId, error: String(err) };
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
  var checked = [], automatic = [], scanned = 0, lastCase = '', limit = Math.min(15, cases.length);
  for (var c = 0; c < limit; c++) {
    var caseId = cases[c]; scanned++; lastCase = caseId;
    try { TaskLedger_readRows(caseId).rows.forEach(function (row) {
      if (row.aiRun === true) checked.push({ caseId: caseId, taskId: row.taskId });
      if (row.aiRun !== true && _TaskLedger_isCandidate(row)) automatic.push({ caseId: caseId, taskId: row.taskId });
    }); }
    catch (e) { console.warn('TaskLedger_pollChecked: ' + caseId + ' / ' + e); }
  }
  if (lastCase) _TaskLedger_writeCursor(cursorName, lastCase);
  var results = [], ran = 0, autoRan = 0;
  for (var i = 0; i < checked.length && i < 1; i++) {
    if (_TaskLedger_nowMs() - started > 240000) break;
    results.push(TaskLedger_runTask(checked[i].caseId, checked[i].taskId, { auto: false })); ran++;
  }
  var hour = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH'));
  if (ran === 0 && (hour >= 22 || hour < 5) && automatic.length && _TaskLedger_nowMs() - started <= 240000) {
    results.push(TaskLedger_runTask(automatic[0].caseId, automatic[0].taskId, { auto: true })); autoRan++;
  }
  return { scannedCases: scanned, cursor: lastCase, checked: checked.length, ran: ran, autoRan: autoRan, results: results, pendingApply: pendingApply };
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
  var started = _TaskLedger_nowMs(), cases = TaskLedger_activeCaseIds(), errors = [], candidates = [];
  cases.forEach(function (caseId) {
    try {
      TaskLedger_readRows(caseId).rows.forEach(function (row) {
        if (_TaskLedger_isCandidate(row)) candidates.push({ caseId: caseId, row: row });
      });
    } catch (e) { errors.push(caseId + ': ' + e); }
  });
  var selected = TaskLedger_selectNightlyCandidates(candidates), results = [], truncated = candidates.length > 2, reason = candidates.length > 2 ? '最大2件' : '';
  for (var i = 0; i < selected.length && i < 2; i++) {
    if (_TaskLedger_nowMs() - started >= 250000) { truncated = true; reason = '経過250秒'; break; }
    results.push(TaskLedger_runTask(selected[i].caseId, selected[i].row.taskId, { auto: true }));
  }
  var ok = 0, failed = 0, skipped = 0;
  results.forEach(function (r) { if (r.ok) ok++; else if (r.skipped) skipped++; else failed++; });
  console.log('候補' + candidates.length + '件 / 実行' + results.length + '件 / 打ち切り: ' + truncated + (reason ? ' (' + reason + ')' : ''));
  return { cases: cases.length, candidates: candidates.length, ran: results.length, ok: ok, failed: failed, skipped: skipped, truncated: truncated, errors: errors };
}

function TaskLedger_panelSummaryValue(caseId) {
  try {
    var read = TaskLedger_readRows(caseId);
    if (!read.sheetUrl) throw new Error('missing');
    var s = TaskLedger_summarize(read.rows, new Date());
    return '=HYPERLINK("' + read.sheetUrl.replace(/"/g, '""') + '","🧭 残タスク ' + s.open + '件 ／ 期限切れ ' + s.overdue + '件 ／ 要確認 ' + s.needsReview + '件 — クリックで台帳を開く")';
  } catch (e) { return '🧭 タスク台帳はまだありません — 上の「🧭 残タスクを洗い出して台帳を更新」を実行してください'; }
}

function TaskLedger_rebuildRollup() {
  var ss = SpreadsheetApp.getActive(), name = '🧭タスク台帳(全案件)', sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  var cases = TaskLedger_activeCaseIds(), allOpen = [], today = new Date(); today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cases.forEach(function (caseId) {
    try {
      var c = CaseList_getById(caseId) || { caseId: caseId, clientName: '', caseName: '' };
      var read = TaskLedger_readRows(caseId);
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
  sheet.getRange(3, 1, 1, 11).setValues([['期限', '状態', 'クライアント', '案件名', 'タスク', '発生源', '担当', 'AI機能', '結果', 'master工程の残', '台帳を開く']]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  if (!rows.length) sheet.getRange(4, 1).setValue('残タスクはありません');
  else {
    var values = displayRows.map(function (x) {
      if (x.overflow) return ['', '', x.c.clientName, x.c.caseName, '… 他 ' + x.overflow + ' 件は案件の台帳で', '', '', '', '', masterByCase[x.caseId] || 0, '=HYPERLINK("' + x.sheetUrl + '","🧭 台帳")'];
      var result = String(x.row.result || '');
      var urlMatch = /(https?:\/\/[^"\s,)]+)/.exec(result);
      if (urlMatch) result = '=HYPERLINK("' + urlMatch[1].replace(/"/g, '""') + '","📄 開く")';
      return [x.row.due, x.row.status, x.c.clientName, x.c.caseName, x.row.taskName, x.row.source, x.row.owner, x.row.aiFeature, result, masterByCase[x.caseId] || 0, '=HYPERLINK("' + x.sheetUrl + '","🧭 台帳")'];
    });
    sheet.getRange(4, 1, values.length, 11).setValues(values);
    displayRows.forEach(function (x, i) { if (!x.overflow && x.row.status === 'AI実行済(要確認)') sheet.getRange(i + 4, 1, 1, 11).setBackground('#e8f5e9'); else if (!x.overflow && x.dueTime < today.getTime()) sheet.getRange(i + 4, 1, 1, 11).setBackground('#fce4ec'); });
  }
  sheet.setFrozenRows(3); [90,130,160,240,300,110,90,220,220,120,90].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
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

if (typeof module !== 'undefined' && module.exports) module.exports = { TaskLedger_normalizeKeyPart: TaskLedger_normalizeKeyPart, TaskLedger_makeKey: TaskLedger_makeKey, TaskLedger_nextTaskId: TaskLedger_nextTaskId, TaskLedger_mergePlan: TaskLedger_mergePlan, TaskLedger_summarize: TaskLedger_summarize, TaskLedger_isAutoRunnable: TaskLedger_isAutoRunnable, TaskLedger_selectActiveCases: TaskLedger_selectActiveCases, TaskLedger_selectNightlyCandidates: TaskLedger_selectNightlyCandidates, TaskLedger_normalizeFeatureLabel: TaskLedger_normalizeFeatureLabel, TaskLedger_lastTaskRowFromValues: TaskLedger_lastTaskRowFromValues, TaskLedger_blankRanges: TaskLedger_blankRanges, _TaskLedger_purgePlan: _TaskLedger_purgePlan, _TaskLedger_deleteRanges: _TaskLedger_deleteRanges };

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
