var DISCORD_TAB_NAME_ = 'Discordチャンネル';
var DISCORD_CHANNEL_HEADERS_ = [
  'カテゴリ','チャンネル名','チャンネルID','種別','親カテゴリID','チャンネルURL',
  '用途・何のチャンネルか【手入力】','担当【手入力】','備考【手入力】',
  '状態','最終確認日(JST)'
];
// 機械列だけを許可することで、手入力列は列順に関係なく書き込み不能にする。
var DISCORD_MACHINE_COLUMNS_ = ['カテゴリ','チャンネル名','種別','親カテゴリID','チャンネルURL','状態','最終確認日(JST)'];

function discordPlanChannels(headers, rows, payload) {
  var idColumn = cloudColumn(headers, 'チャンネルID', true);
  var columns = {};
  DISCORD_MACHINE_COLUMNS_.concat(['チャンネルID']).forEach(function(name) {
    columns[name] = cloudColumn(headers, name, true);
  });
  var updates = [];
  var appendRows = [];
  var missing = [];
  var seen = {};
  var checkedAt = payload && payload.checkedAt || '';
  (payload && Array.isArray(payload.channels) ? payload.channels : []).forEach(function(channel) {
    var id = String(channel.id == null ? '' : channel.id);
    seen[id] = true;
    var index = rows.findIndex(function(row) { return String(row[idColumn] == null ? '' : row[idColumn]) === id; });
    var values = {
      'カテゴリ': channel.category || '', 'チャンネル名': channel.name || '', '種別': channel.type || '',
      '親カテゴリID': channel.parentId || '', 'チャンネルURL': channel.url || '',
      '状態': 'あり', '最終確認日(JST)': checkedAt
    };
    if (index < 0) {
      var output = headers.map(function() { return ''; });
      output[idColumn] = id;
      DISCORD_MACHINE_COLUMNS_.forEach(function(name) { output[columns[name]] = values[name]; });
      appendRows.push(output);
      return;
    }
    DISCORD_MACHINE_COLUMNS_.forEach(function(name) {
      if (String(rows[index][columns[name]] == null ? '' : rows[index][columns[name]]) !== String(values[name])) {
        updates.push({ rowNumber: index + 2, columnIndex: columns[name] + 1, value: values[name] });
      }
    });
  });
  rows.forEach(function(row, index) {
    var id = String(row[idColumn] == null ? '' : row[idColumn]);
    if (!id || seen[id]) return;
    missing.push(id);
    var missingValues = { '状態': '削除/非表示', '最終確認日(JST)': checkedAt };
    Object.keys(missingValues).forEach(function(name) {
      if (String(row[columns[name]] == null ? '' : row[columns[name]]) !== String(missingValues[name])) {
        updates.push({ rowNumber: index + 2, columnIndex: columns[name] + 1, value: missingValues[name] });
      }
    });
  });
  return { updates: updates, appendRows: appendRows, missing: missing };
}

function discordMatchRows(headers, rows, options) {
  options = options || {};
  var columnNames = {
    id: 'チャンネルID', name: 'チャンネル名', category: 'カテゴリ', type: '種別',
    url: 'チャンネルURL', purpose: '用途・何のチャンネルか【手入力】',
    owner: '担当【手入力】', note: '備考【手入力】', state: '状態', checkedAt: '最終確認日(JST)'
  };
  var columns = {};
  Object.keys(columnNames).forEach(function(key) { columns[key] = cloudColumn(headers, columnNames[key], true); });
  var normalize = function(value) { return String(value == null ? '' : value).toLowerCase().replace(/[ \u3000]/g, ''); };
  var query = normalize(options.query);
  var idQuery = /^\d{19}$/.test(String(options.query == null ? '' : options.query).trim());
  var requestedLimit = Number(options.limit);
  var limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(200, Math.floor(requestedLimit)) : 50;
  var matches = rows.filter(function(row) {
    var state = String(row[columns.state] == null ? '' : row[columns.state]);
    if (!options.includeMissing && state === '削除/非表示') return false;
    if (!query) return true;
    if (idQuery) return String(row[columns.id] == null ? '' : row[columns.id]).trim() === String(options.query).trim();
    var name = normalize(row[columns.name]);
    return options.exact ? name === query : name.indexOf(query) >= 0;
  });
  return {
    count: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    rows: matches.slice(0, limit).map(function(row) {
      var result = {};
      Object.keys(columns).forEach(function(key) { result[key] = String(row[columns[key]] == null ? '' : row[columns[key]]); });
      return result;
    })
  };
}
