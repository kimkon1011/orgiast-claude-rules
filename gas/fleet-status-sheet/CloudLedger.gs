// GAS はファイルをアルファベット順に評価するので、CloudLedger.gs のトップレベルからは
// CloudLedgerLogic.gs の定数がまだ undefined に見える。定数をそのまま束ねた var にすると
// 「Cannot read properties of undefined (reading 'length')」で全機能が落ちる(実測)。
// 呼ばれた時点で組み立てる関数にして、評価順に依存しないようにする。
function _cloudTabs_() {
  return {
    'プロジェクト所在地図': CLOUD_PROJECT_HEADERS_,
    'クラウド契約': CLOUD_CONTRACT_HEADERS_,
    'PCログイン': CLOUD_LOGIN_HEADERS_
  };
}

// ヘッダ行が無いタブは列数0になり、以降の読み取りが
// 「範囲の列数には 1 以上を指定してください」で落ちる。空のときだけ補う。
function _cloudEnsureHeaders_(sheet, headers) {
  if (sheet.getLastRow() !== 0 && sheet.getLastColumn() !== 0) return false;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return true;
}

function _cloudSheet_(tabName) {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
  if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var book = SpreadsheetApp.openById(id);
  var sheet = book.getSheetByName(tabName);
  if (!sheet) sheet = book.insertSheet(tabName);
  _cloudEnsureHeaders_(sheet, _cloudTabs_()[tabName]);
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
    return { ok: true, deleted: plan.deleteRowNumbers.length, appended: plan.appendRows.length, seeded: seed.appendRows.length, droppedManual: plan.droppedManual };
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
    Object.keys(_cloudTabs_()).forEach(function(name) {
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

// 契約タブの中身を検証するための診断。返す列は許可リストで固定する。
// 台帳を丸ごと読むと巨大タブと機密列まで持ち出すので、必要な列だけ返す経路を用意する。
var CLOUD_CONTRACT_SAFE_COLUMNS_ = [
  'サービス', 'アカウント(ログインID)', 'プラン', '月額(税込)', '通貨',
  '支払い元(名義)', '請求サイクル', '最終確認日', '自動検出'
];

function describeCloudContracts() {
  return _cloudWithLock_(function() {
    var data = _cloudRead_('クラウド契約');
    var columns = CLOUD_CONTRACT_SAFE_COLUMNS_.map(function(name) {
      return { name: name, index: cloudColumn(data.headers, name, true) };
    }).filter(function(column) { return column.index >= 0; });
    return {
      ok: true,
      columns: columns.map(function(column) { return column.name; }),
      rowCount: data.rows.length,
      rows: data.rows.map(function(row) {
        return columns.map(function(column) { return row[column.index]; });
      })
    };
  });
}

function _cloudFailure_(error) {
  return '失敗(' + (error && error.message ? error.message : String(error)) + ')';
}

// 不足しているタブだけをヘッダ付きで補い、Google が勝手に作る空の既定シートを片付ける。
// 既存タブの中身には触らない。作成の途中で失敗した台帳(タブが1枚だけ等)を
// 再実行だけで正しい形へ寄せるための修復処理でもある。
function _cloudEnsureTabs_(book) {
  var definitions = _cloudTabs_();
  var created = [];
  var repaired = [];
  Object.keys(definitions).forEach(function(name) {
    var sheet = book.getSheetByName(name);
    if (!sheet) {
      sheet = book.insertSheet(name);
      _cloudEnsureHeaders_(sheet, definitions[name]);
      created.push(name);
      return;
    }
    // タブだけ作られてヘッダを書く前に落ちた台帳が実在した(2026-08-28 実測)。
    // 1行でも入っているタブには触らない。
    if (_cloudEnsureHeaders_(sheet, definitions[name])) repaired.push(name);
  });
  // 既定シートは中身が空のときだけ消す。人が使い始めていたら残す。
  ['シート1', 'Sheet1'].forEach(function(name) {
    var sheet = book.getSheetByName(name);
    if (sheet && book.getSheets().length > 1 && sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {
      book.deleteSheet(sheet);
    }
  });
  return { created: created, repaired: repaired };
}

function setupCloudLedger() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('CLOUD_LEDGER_SHEET_ID');
  var book;
  var id;
  var createdNow = false;
  if (existing) {
    book = SpreadsheetApp.openById(existing);
    id = existing;
  } else {
    book = SpreadsheetApp.create('オージャスト クラウド契約・プロジェクト台帳');
    id = book.getId();
    // 作成直後に ID を確定し、後続の失敗で二重作成されないようにする。
    props.setProperty('CLOUD_LEDGER_SHEET_ID', id);
    createdNow = true;
  }
  var tabPlan = _cloudEnsureTabs_(book);

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
    tabs: book.getSheets().map(function(sheet) { return sheet.getName(); }),
    createdSpreadsheet: createdNow,
    createdTabs: tabPlan.created,
    repairedTabs: tabPlan.repaired,
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
