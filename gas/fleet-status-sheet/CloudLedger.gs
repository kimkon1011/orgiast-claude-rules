var CLOUD_TABS_ = {
  'プロジェクト所在地図': CLOUD_PROJECT_HEADERS_,
  'クラウド契約': CLOUD_CONTRACT_HEADERS_,
  'PCログイン': CLOUD_LOGIN_HEADERS_
};

function _cloudSheet_(tabName) {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
  if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var book = SpreadsheetApp.openById(id);
  var sheet = book.getSheetByName(tabName);
  if (!sheet) {
    sheet = book.insertSheet(tabName);
    sheet.getRange(1, 1, 1, CLOUD_TABS_[tabName].length).setValues([CLOUD_TABS_[tabName]]);
  }
  return sheet;
}

function _cloudApply_(sheet, plan) {
  (plan.deleteRowNumbers || []).slice().sort(function(a, b) { return b - a; }).forEach(function(row) {
    sheet.deleteRow(row);
  });
  (plan.updates || []).forEach(function(update) {
    sheet.getRange(update.rowNumber, update.columnIndex).setValue(update.value);
  });
  if (plan.appendRows && plan.appendRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, plan.appendRows.length, plan.appendRows[0].length)
      .setValues(plan.appendRows);
  }
}

function _cloudWithLock_(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function _cloudRead_(name) {
  var sheet = _cloudSheet_(name);
  var columns = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  return {
    sheet: sheet,
    headers: sheet.getRange(1, 1, 1, columns).getDisplayValues()[0],
    rows: lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, columns).getDisplayValues() : []
  };
}

function replaceCloudLogins(payload) {
  return _cloudWithLock_(function() {
    var data = _cloudRead_('PCログイン');
    var plan = cloudPlanLoginReplace(data.headers, data.rows, payload);
    _cloudApply_(data.sheet, plan);
    var contracts = _cloudRead_('クラウド契約');
    var reportedDate = payload.reportedAt ? String(payload.reportedAt).slice(0, 10) : '';
    var seed = cloudPlanContractSeed(contracts.headers, contracts.rows, payload.rows, reportedDate);
    _cloudApply_(contracts.sheet, seed);
    return { ok: true, deleted: plan.deleteRowNumbers.length, appended: plan.appendRows.length, seeded: seed.appendRows.length };
  });
}

function upsertCloudProjects(payload) {
  return _cloudWithLock_(function() {
    var data = _cloudRead_('プロジェクト所在地図');
    var plan = cloudPlanProjectUpsert(data.headers, data.rows, payload);
    _cloudApply_(data.sheet, plan);
    return { ok: true, updated: plan.updates.length, appended: plan.appendRows.length };
  });
}

function upsertCloudContracts(payload) {
  return _cloudWithLock_(function() {
    var data = _cloudRead_('クラウド契約');
    var plan = cloudPlanContractUpsert(data.headers, data.rows, payload);
    _cloudApply_(data.sheet, plan);
    return { ok: true, updated: plan.updates.length, appended: plan.appendRows.length };
  });
}

function describeCloudLedger() {
  return _cloudWithLock_(function() {
    var result = { ok: true, tabs: {} };
    Object.keys(CLOUD_TABS_).forEach(function(name) {
      var data = _cloudRead_(name);
      var keyNames;
      if (name === 'プロジェクト所在地図') {
        keyNames = ['GitHubリポジトリ', 'プロジェクト名'];
      } else if (name === 'クラウド契約') {
        keyNames = ['サービス', 'アカウント(ログインID)'];
      } else {
        keyNames = ['PC名/ホスト名', 'サービス', 'ログインアカウント'];
      }
      var keyColumns = keyNames.map(function(key) { return cloudColumn(data.headers, key, true); });
      result.tabs[name] = {
        headers: data.headers.slice(),
        rowCount: data.rows.length,
        keys: data.rows.map(function(row) {
          return keyColumns.map(function(column) { return row[column]; });
        })
      };
    });
    return result;
  });
}

function _cloudFailure_(error) {
  return '失敗(' + (error && error.message ? error.message : String(error)) + ')';
}

function setupCloudLedger() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('CLOUD_LEDGER_SHEET_ID');
  if (existing) {
    var current = SpreadsheetApp.openById(existing);
    return {
      ok: true,
      sheetId: existing,
      url: 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + existing + '/edit',
      tabs: current.getSheets().map(function(sheet) { return sheet.getName(); }),
      sharing: 'DOMAIN',
      movedToFolder: false
    };
  }

  var book = SpreadsheetApp.create('オージャスト クラウド契約・プロジェクト台帳');
  var id = book.getId();
  // 作成直後に ID を確定し、後続の共有・移動失敗で二重作成されないようにする。
  props.setProperty('CLOUD_LEDGER_SHEET_ID', id);
  var first = book.getSheets()[0];
  Object.keys(CLOUD_TABS_).forEach(function(name) {
    var sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, CLOUD_TABS_[name].length).setValues([CLOUD_TABS_[name]]);
  });
  book.deleteSheet(first);

  var file = DriveApp.getFileById(id);
  var sharing = 'DOMAIN';
  try {
    file.setSharing(DriveApp.Access.DOMAIN, DriveApp.Permission.EDIT);
  } catch (error) {
    sharing = _cloudFailure_(error);
  }

  var movedToFolder = false;
  var folderId = props.getProperty('CLOUD_LEDGER_FOLDER_ID');
  if (folderId) {
    try {
      file.moveTo(DriveApp.getFolderById(folderId));
      movedToFolder = true;
    } catch (error) {
      movedToFolder = _cloudFailure_(error);
    }
  }
  return {
    ok: true,
    sheetId: id,
    url: 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + id + '/edit',
    tabs: Object.keys(CLOUD_TABS_),
    sharing: sharing,
    movedToFolder: movedToFolder
  };
}

function setCloudLedgerFolder(args) {
  var folderId = args && typeof args.folderId === 'string' ? args.folderId.trim() : '';
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folderId)) throw new Error('folderId looks invalid');
  PropertiesService.getScriptProperties().setProperty('CLOUD_LEDGER_FOLDER_ID', folderId);
  return { ok: true, folderId: folderId };
}
