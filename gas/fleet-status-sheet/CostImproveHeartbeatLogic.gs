function fleetPlanCostImproveHeartbeat(headers, rows, payload) {
  const columns = fleetResolveColumns(headers);
  const label = String(payload && payload.label || '').trim();
  if (!label) throw new Error('label_required');
  const rowIndex = rows.findIndex(function(row) {
    return String(row[columns.hostname] || '').trim() === label
      || String(row[columns.selfPc] || '').trim() === label;
  });
  if (rowIndex < 0) throw new Error('heartbeat_pc_not_found');
  // 列が両方無いと「書いたつもりで1セルも書いていない」まま ok を返してしまい、
  // 見張り側は「実行されていない」と誤検知する。書けないことは失敗として返す。
  if (columns.costLoopRanAt < 0 && columns.costLoopStatus < 0) throw new Error('heartbeat_columns_missing');
  const values = {};
  if (columns.costLoopRanAt >= 0) values[columns.costLoopRanAt] = payload.ranAt || '';
  if (columns.costLoopStatus >= 0) values[columns.costLoopStatus] = payload.status || '';
  return { rowIndex: rowIndex, values: values };
}

// 週次コスト改善ループ(OrgiastCostWeeklyImprove)の heartbeat。日次とは別の列 pair に書く
// (日次の列を上書きすると日次 watchdog の 36h 監視が誤検知するため。仕様C3)。
function fleetPlanCostWeeklyHeartbeat(headers, rows, payload) {
  const columns = fleetResolveColumns(headers);
  const label = String(payload && payload.label || '').trim();
  if (!label) throw new Error('label_required');
  const rowIndex = rows.findIndex(function(row) {
    return String(row[columns.hostname] || '').trim() === label
      || String(row[columns.selfPc] || '').trim() === label;
  });
  if (rowIndex < 0) throw new Error('heartbeat_pc_not_found');
  if (columns.costWeeklyRanAt < 0 && columns.costWeeklyStatus < 0) throw new Error('heartbeat_columns_missing');
  const values = {};
  if (columns.costWeeklyRanAt >= 0) values[columns.costWeeklyRanAt] = payload.ranAt || '';
  if (columns.costWeeklyStatus >= 0) values[columns.costWeeklyStatus] = payload.status || '';
  return { rowIndex: rowIndex, values: values };
}
