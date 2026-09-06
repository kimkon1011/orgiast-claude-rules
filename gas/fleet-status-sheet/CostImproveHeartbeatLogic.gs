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
