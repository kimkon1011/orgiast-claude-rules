function _ledgerWriteIndex_(book, fleetTabName, props, ledgerId) {
  var sheet = book.getSheetByName('目次');
  if (!sheet) sheet = book.insertSheet('目次');
  sheet.clear();
  var rows = buildIndexRows(
    [fleetTabName], ledgerId, props.getProperty('PC_INVENTORY_SHEET_ID') || '', FLEET_SHEET_ID_
  );
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange('A1').setFontWeight('bold').setFontSize(14);
  [4, 16].forEach(function(row) {
    sheet.getRange(row, 1, 1, row === 4 ? 5 : 3).setFontWeight('bold').setBackground('#d9eaf7');
  });
  sheet.autoResizeColumns(1, 5);
  sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(protection) { protection.remove(); });
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(protection) { protection.remove(); });
  book.setActiveSheet(sheet);
  book.moveActiveSheet(1);
  return sheet;
}

function _ledgerMarkLegacy_(sourceBook, tabNames, ledgerId) {
  tabNames.forEach(function(name) {
    var source = sourceBook.getSheetByName(name);
    var migratedName = unifyLegacyTabName(name);
    if (source && !sourceBook.getSheetByName(migratedName)) source.setName(migratedName);
  });
  var notice = sourceBook.getSheetByName('▶この表は移行しました');
  if (!notice) notice = sourceBook.insertSheet('▶この表は移行しました', 0);
  notice.getRange('A1:A3').clearContent();
  notice.getRange('A1:A3').setValues([
    ['この表は「オージャスト クラウド契約・プロジェクト台帳」へ統合されました（2026-08-30）。'],
    ['https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + ledgerId + '/edit'],
    ['以後の自動更新はすべて台帳側に入ります。この表は参照用に残しているだけで、更新されません。']
  ]);
  notice.getRange('A1').setFontWeight('bold');
  notice.setColumnWidth(1, 760);
}

function unifyIntoCloudLedger(args) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, status: 503, error: 'busy' };
  try {
    var dryRun = !!(args && args.dryRun === true);
    var props = PropertiesService.getScriptProperties();
    var sourceId = props.getProperty('SHEET_ID');
    var ledgerId = props.getProperty('CLOUD_LEDGER_SHEET_ID');
    if (!ledgerId) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
    var ledgerUrl = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + ledgerId + '/edit';
    var destination = SpreadsheetApp.openById(ledgerId);
    var alreadyUnified = sourceId === ledgerId;
    var fleetTabName;
    var movedTabs = [];
    var skippedTabs = [];
    var cachedTabNameBefore = props.getProperty('SHEET_TAB_NAME');

    if (alreadyUnified) {
      var cachedName = props.getProperty('SHEET_TAB_NAME');
      fleetTabName = cachedName && destination.getSheetByName(cachedName) ? cachedName : _fleetSheet_().getName();
    } else {
      var source = SpreadsheetApp.openById(sourceId);
      fleetTabName = _fleetSheet_().getName();
      var targets = [fleetTabName];
      if (source.getSheetByName(EXT_SHEET_NAME_)) targets.push(EXT_SHEET_NAME_);
      var plan = unifyPlanTabs(
        source.getSheets().map(function(sheet) { return sheet.getName(); }),
        destination.getSheets().map(function(sheet) { return sheet.getName(); }),
        targets,
        fleetTabName
      );
      movedTabs = plan.toCopy.map(function(name) { return unifyDestTabName(name, fleetTabName); });
      skippedTabs = plan.toSkip.slice();
      if (!dryRun) {
        plan.toCopy.forEach(function(name) {
          source.getSheetByName(name).copyTo(destination).setName(unifyDestTabName(name, fleetTabName));
        });
        _ledgerMarkLegacy_(source, targets, ledgerId);
      }
      fleetTabName = unifyDestTabName(fleetTabName, fleetTabName);
    }

    // _fleetSheet_() は探索結果をキャッシュするため、書き込み禁止の dry-run では元の状態へ戻す。
    if (dryRun) {
      if (cachedTabNameBefore) props.setProperty('SHEET_TAB_NAME', cachedTabNameBefore);
      else props.deleteProperty('SHEET_TAB_NAME');
    }

    if (!dryRun) {
      _ledgerWriteIndex_(destination, fleetTabName, props, ledgerId);
      // 統合後に旧 ID へ戻すと全 PC の夜間報告が旧シートへ逆流するため、切替は全処理の最後に行う。
      props.setProperty('SHEET_ID', ledgerId);
      props.deleteProperty('SHEET_TAB_NAME');
    }
    return {
      ok: true, alreadyUnified: alreadyUnified, movedTabs: movedTabs, skippedTabs: skippedTabs,
      ledgerSheetId: ledgerId, ledgerUrl: ledgerUrl, indexTab: '目次'
    };
  } finally {
    lock.releaseLock();
  }
}
