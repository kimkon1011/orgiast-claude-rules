function _pcInventorySheet_() {
  var properties=PropertiesService.getScriptProperties(); var id=properties.getProperty('PC_INVENTORY_SHEET_ID');
  if(!id) throw new Error('PC_INVENTORY_SHEET_ID is not configured');
  var book=SpreadsheetApp.openById(id); var cached=properties.getProperty('PC_INVENTORY_TAB_NAME');
  if(cached && book.getSheetByName(cached)) return book.getSheetByName(cached);
  var sheet=book.getSheetByName('PC管理表'); if(!sheet) throw new Error('PC管理表 tab not found');
  properties.setProperty('PC_INVENTORY_TAB_NAME',sheet.getName()); return sheet;
}
// 1行目が見出しとは限らない。実シートは1行目が結合されたタイトル行(『レンタル管理表』等)で、
// 見出しは数行下にある。『コンピュータ名』を含む行を見出し行として探し、行番号をキャッシュする。
function _pcFindHeaderRow_(sheet) {
  var properties = PropertiesService.getScriptProperties();
  var lastColumn = sheet.getLastColumn();
  var cached = Number(properties.getProperty('PC_INVENTORY_HEADER_ROW') || 0);
  if (cached > 0) {
    var cachedHeaders = sheet.getRange(cached, 1, 1, lastColumn).getDisplayValues()[0];
    if (pcFindHeader(cachedHeaders, PC_SPEC_FIELDS_.computerName) >= 0) return { row: cached, headers: cachedHeaders };
    properties.deleteProperty('PC_INVENTORY_HEADER_ROW');
  }
  var scan = Math.min(10, sheet.getLastRow());
  for (var row = 1; row <= scan; row += 1) {
    var headers = sheet.getRange(row, 1, 1, lastColumn).getDisplayValues()[0];
    if (pcFindHeader(headers, PC_SPEC_FIELDS_.computerName) >= 0) {
      properties.setProperty('PC_INVENTORY_HEADER_ROW', String(row));
      return { row: row, headers: headers };
    }
  }
  throw new Error('header row containing コンピュータ名 not found in the first ' + scan + ' rows');
}

function upsertPcInventory(payload) {
  var lock=LockService.getScriptLock(); if(!lock.tryLock(20000)) return {ok:false,status:503,error:'busy'};
  try {
    var sheet=_pcInventorySheet_(); var lastColumn=sheet.getLastColumn(); var lastRow=sheet.getLastRow();
    var found=_pcFindHeaderRow_(sheet); var headerRow=found.row; var headers=found.headers;
    var rows=lastRow>headerRow?sheet.getRange(headerRow+1,1,lastRow-headerRow,lastColumn).getValues():[];
    var copy=JSON.parse(JSON.stringify(payload||{})); copy.updatedAt=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd');
    var plan=fleetPlanPcInventory(headers,rows,copy); var target=plan.rowIndex+headerRow+1;
    // 書き込んだ列の見出しを返す。呼び出し側はシート本文を読まずに
    // 「許可リスト外の列に書いていないこと」を本番で検証できる(このシートはパスワード列を含む)。
    var written=[];
    Object.keys(plan.values).forEach(function(col){sheet.getRange(target,Number(col)+1).setValue(plan.values[col]);written.push(headers[Number(col)]);});
    return {ok:true,action:plan.action,row:target,written:written};
  } finally { lock.releaseLock(); }
}
