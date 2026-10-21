const PLAN_USAGE_FEEDBACK_URL_ = 'https://script.google.com/macros/s/AKfycbzzOD2hA2hNKK8SccyRGf0tFivf_WS_VjWzOS5RgVnM3VD63jpu0xcprAOxUcDmuxlC/exec?form=feedback&app=' + encodeURIComponent('Claude上限ダッシュボード');
const PLAN_USAGE_HEADERS_ = ['アカウント', '5h残り', '5hリセット', '週残り', '週リセット', 'モデル別週枠', '状態', '最終報告(JST)', '報告PC', '5h消化率(生)', '週消化率(生)', '5hリセット日時', '週リセット日時'];

function planUsageKey(payload) {
  return String(payload.claudeAccount || '').trim().toLowerCase() || '(不明) ' + String(payload.label || '').trim();
}

function planUsageDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : date;
}

function planUsagePercent(value) {
  return typeof value === 'number' && isFinite(value) ? value : '';
}

function planUsageScopedText(scoped) {
  return (Array.isArray(scoped) ? scoped : []).filter(function(limit) {
    return planUsagePercent(limit.percent) !== '';
  }).map(function(limit) {
    const date = planUsageDate(limit.resetsAt);
    let reset = '';
    if (date) {
      const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      const pad = function(n) { return String(n).padStart(2, '0'); };
      reset = '（' + (jst.getUTCMonth() + 1) + '/' + jst.getUTCDate() + ' ' + pad(jst.getUTCHours()) + ':' + pad(jst.getUTCMinutes()) + '）';
    }
    return String(limit.label || '') + ' 残り' + Math.max(0, Math.min(100, Math.round((100 - limit.percent) * 10) / 10)) + '%' + reset;
  }).join(' / ');
}

function planUsageFormulas(row) {
  return [
    '=IF(J' + row + '="","",IF(AND(L' + row + '<>"",NOW()>L' + row + '),1,MAX(0,MIN(1,(100-J' + row + ')/100))))',
    '=IF(L' + row + '="","",L' + row + ')',
    '=IF(K' + row + '="","",IF(AND(M' + row + '<>"",NOW()>M' + row + '),1,MAX(0,MIN(1,(100-K' + row + ')/100))))',
    '=IF(M' + row + '="","",M' + row + ')'
  ];
}

function planUsageUpsert(rows, payload) {
  if (!String(payload.label || '').trim()) throw new Error('label_required');
  const reportedAt = String(payload.reportedAt || '');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(reportedAt)) throw new Error('reportedAt_required');
  const key = planUsageKey(payload);
  const index = rows.findIndex(function(row) {
    const account = String(row[0] || '').trim();
    return (account.indexOf('(不明) ') === 0 ? account : account.toLowerCase()) === key;
  });
  if (index >= 0 && String(rows[index][7] || '') > reportedAt) return { action: 'ignored', rowIndex: index };
  const row = index >= 0 ? rows[index].slice() : PLAN_USAGE_HEADERS_.map(function() { return ''; });
  row[0] = key;
  row[6] = payload.available === true ? 'OK' : '計測不能: ' + String(payload.reason || 'unknown');
  row[7] = reportedAt;
  row[8] = String(payload.label) + (payload.hostname && payload.hostname !== payload.label ? ' (' + payload.hostname + ')' : '');
  if (payload.available === true) {
    row[5] = planUsageScopedText(payload.scoped);
    row[9] = planUsagePercent(payload.fiveHourPct);
    row[10] = planUsagePercent(payload.sevenDayPct);
    row[11] = planUsageDate(payload.fiveHourResetsAt);
    row[12] = planUsageDate(payload.sevenDayResetsAt);
  }
  const rowIndex = index >= 0 ? index : rows.length;
  planUsageFormulas(rowIndex + 2).forEach(function(formula, i) { row[i + 1] = formula; });
  return { action: index >= 0 ? 'updated' : 'inserted', rowIndex: rowIndex, row: row };
}
