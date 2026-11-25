function taskLedgerColumn(headers, name, required) {
  var index = headers.indexOf(name);
  if (required && index < 0) throw new Error('required header not found: ' + name);
  return index;
}

function taskLedgerFindRowIndex(headers, rows, taskId) {
  var taskIdColumn = taskLedgerColumn(headers, 'taskId', true);
  return rows.findIndex(function(row) {
    return String(row[taskIdColumn] == null ? '' : row[taskIdColumn]) === String(taskId);
  });
}

function taskLedgerPlanUpsert(headers, rows, args, nowIso) {
  args = args || {};
  var taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (!taskId) throw new Error('taskId is required');

  var rowIndex = taskLedgerFindRowIndex(headers, rows, taskId);
  var existing = rowIndex >= 0 ? rows[rowIndex] : null;
  var values = {
    'taskId': taskId,
    '起票元': args.起票元 || '',
    '件名': args.件名 || '',
    '依頼元': args.依頼元 || '',
    '担当PC': args.担当PC || '',
    '状態': Object.prototype.hasOwnProperty.call(args, '状態')
      ? args.状態
      : (existing ? existing[taskLedgerColumn(headers, '状態', true)] : '未着手'),
    '次アクション': args.次アクション || '',
    '成果物リンク': args.成果物リンク || '',
    '期限': args.期限 || '',
    '最終更新': nowIso,
    '備考': args.備考 || ''
  };
  var row = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(values, header) ? values[header] : '';
  });
  return { rowIndex: rowIndex < 0 ? rows.length : rowIndex, row: row, action: rowIndex < 0 ? 'insert' : 'update' };
}

function taskLedgerPlanClaim(headers, rows, args, nowIso) {
  args = args || {};
  var owner = typeof args.担当PC === 'string' ? args.担当PC.trim() : '';
  if (!owner) throw new Error('担当PC is required');
  var rowIndex = taskLedgerFindRowIndex(headers, rows, args.taskId);
  if (rowIndex < 0) return { ok: false, error: 'not_found' };
  var ownerColumn = taskLedgerColumn(headers, '担当PC', true);
  var existingOwner = String(rows[rowIndex][ownerColumn] == null ? '' : rows[rowIndex][ownerColumn]);
  if (existingOwner !== '') return { ok: false, error: 'already_claimed', owner: existingOwner };
  return {
    ok: true,
    rowIndex: rowIndex,
    updates: [
      { column: '担当PC', value: owner },
      { column: '状態', value: args.状態 || '実行中' },
      { column: '最終更新', value: nowIso }
    ]
  };
}

function taskLedgerPlanDone(headers, rows, args, nowIso) {
  args = args || {};
  var rowIndex = taskLedgerFindRowIndex(headers, rows, args.taskId);
  if (rowIndex < 0) return { ok: false, error: 'not_found' };
  var updates = [{ column: '状態', value: '完了' }];
  if (Object.prototype.hasOwnProperty.call(args, '成果物リンク')) {
    updates.push({ column: '成果物リンク', value: args.成果物リンク });
  }
  if (Object.prototype.hasOwnProperty.call(args, '備考')) {
    updates.push({ column: '備考', value: args.備考 });
  }
  updates.push({ column: '最終更新', value: nowIso });
  return { ok: true, rowIndex: rowIndex, updates: updates };
}

function taskLedgerFilterRows(rowsAsObjects, args) {
  args = args || {};
  return rowsAsObjects.filter(function(row) {
    return (!args.taskId || row.taskId === args.taskId) &&
      (!args.状態 || row.状態 === args.状態) &&
      (!args.担当PC || row.担当PC === args.担当PC);
  });
}
