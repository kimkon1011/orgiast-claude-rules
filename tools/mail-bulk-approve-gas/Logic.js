// Shared unchanged by GAS and the Node tests. No Google services in this file.
function approvalMail(row) {
  if (row[5] !== true || row[6] || row[7]) return null;
  var address = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
  var to = String(row[1] || '');
  var cc = String(row[2] || '');
  if (/[\r\n]/.test(to + cc) || !to.split(',').every(function (s) { return address.test(s.trim()); }) ||
      (cc && !cc.split(',').every(function (s) { return address.test(s.trim()); })) ||
      !row[3] || /[\r\n]/.test(row[3]) || !row[4]) throw new Error('宛先・件名・本文を確認してください');
  return { company: row[0], to: to, cc: cc, subject: String(row[3]), body: String(row[4]) };
}
function approvalRows(startRow, rowCount, startColumn, columnCount) {
  if (startColumn > 6 || startColumn + columnCount <= 6) return [];
  var rows = [];
  for (var i = Math.max(2, startRow); i < startRow + rowCount; i++) rows.push(i);
  return rows;
}
