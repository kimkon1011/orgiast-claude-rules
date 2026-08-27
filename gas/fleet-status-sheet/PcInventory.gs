function _pcInventorySheet_() {
  var properties=PropertiesService.getScriptProperties(); var id=properties.getProperty('PC_INVENTORY_SHEET_ID');
  if(!id) throw new Error('PC_INVENTORY_SHEET_ID is not configured');
  var book=SpreadsheetApp.openById(id); var cached=properties.getProperty('PC_INVENTORY_TAB_NAME');
  if(cached && book.getSheetByName(cached)) return book.getSheetByName(cached);
  var sheet=book.getSheetByName('PC管理表'); if(!sheet) throw new Error('PC管理表 tab not found');
  properties.setProperty('PC_INVENTORY_TAB_NAME',sheet.getName()); return sheet;
}
function upsertPcInventory(payload) {
  var lock=LockService.getScriptLock(); if(!lock.tryLock(20000)) return {ok:false,status:503,error:'busy'};
  try {
    var sheet=_pcInventorySheet_(); var lastColumn=sheet.getLastColumn(); var lastRow=sheet.getLastRow();
    var headers=sheet.getRange(1,1,1,lastColumn).getDisplayValues()[0]; var rows=lastRow>1?sheet.getRange(2,1,lastRow-1,lastColumn).getValues():[];
    var copy=JSON.parse(JSON.stringify(payload||{})); copy.updatedAt=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd');
    var plan=fleetPlanPcInventory(headers,rows,copy); var target=plan.rowIndex+2;
    Object.keys(plan.values).forEach(function(col){sheet.getRange(target,Number(col)+1).setValue(plan.values[col]);});
    return {ok:true,action:plan.action,row:target};
  } finally { lock.releaseLock(); }
}
