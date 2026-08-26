function clearFleetMachineColumns(args) {
  const staff = args && typeof args.staff === 'string' ? args.staff.trim() : '';
  const selfPc = args && typeof args.selfPc === 'string' ? args.selfPc.trim() : '';
  if (!staff) throw new Error('staff is required');
  if (!selfPc) throw new Error('selfPc is required');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetSheet_();
    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const columns = fleetResolveColumns(headers);
    const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : [];
    const matchingIndexes = [];

    rows.forEach(function(row, index) {
      if (String(row[columns.staff]).trim() === staff && String(row[columns.selfPc]).trim() === selfPc) {
        matchingIndexes.push(index);
      }
    });

    // 1件に絞れないまま消すと、同姓・同名PCなどの別人の行まで巻き込むため必ず停止する。
    if (matchingIndexes.length !== 1) {
      throw new Error('matching row count must be exactly 1: ' + matchingIndexes.length);
    }

    const rowIndex = matchingIndexes[0];
    const row = rows[rowIndex];
    const targetRow = rowIndex + 2;
    if (args && args.expectedHostname != null) {
      const expectedHostname = String(args.expectedHostname).trim();
      const actualHostname = String(row[columns.hostname]).trim();
      // F列を先に確認し、別PCから届いた実測値を取り違えて消す事故を防ぐ。
      if (actualHostname !== expectedHostname) {
        throw new Error('hostname mismatch: expected ' + expectedHostname + ', actual ' + actualHostname);
      }
    }

    const clearedKeys = ['hostname', 'reportedAt', 'claudeUsd', 'mainModel', 'delegRatio', 'cheapAiUse', 'codexLogin', 'fable5', 'disciplineAlert', 'consistency'];
    const previous = {};
    clearedKeys.forEach(function(key) {
      previous[key] = row[columns[key]];
    });

    // 消した実測値は対象PCの次回報告で入り直すため失われない。A〜Eの自己申告値は触らない。
    clearedKeys.forEach(function(key) {
      sheet.getRange(targetRow, columns[key] + 1).clearContent();
    });

    return { ok: true, row: targetRow, clearedKeys: clearedKeys, previous: previous };
  } finally {
    lock.releaseLock();
  }
}
