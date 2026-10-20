/** Read-only: run the real allocator against a write-recording sheet facade. */
function _debug_itemAppendPosition(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var sheet = _Procure_itemSheet(_Procure_openZissi(c));
  var cols = _Procure_findColumns(sheet) || {};
  if (!cols['品名']) cols['品名'] = 6; /* Original template name column before procurement headers exist. */
  var inserts = [];
  var facade = {
    getLastRow: function () { return sheet.getLastRow(); },
    getLastColumn: function () { return sheet.getLastColumn(); },
    getRange: function () {
      var args = Array.prototype.slice.call(arguments);
      return {
        getDisplayValues: function () { return sheet.getRange.apply(sheet, args).getDisplayValues(); },
        getMergedRanges: function () { return sheet.getRange.apply(sheet, args).getMergedRanges(); },
        breakApart: function () {}
      };
    },
    insertRowsAfter: function (row, count) { inserts.push({ after: row, count: count }); }
  };
  return { caseId: caseId, markerRow: _Procure_appendMarkerRow(sheet),
    nextRow: _Procure_pickWritableRow(facade, cols, new Set()), inserts: inserts };
}
