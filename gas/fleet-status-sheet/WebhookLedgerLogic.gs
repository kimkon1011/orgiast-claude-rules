var WEBHOOK_TAB_NAME_ = 'Webhook';
var WEBHOOK_HEADERS_ = [
  'Webhook名','対象チャンネル名','チャンネルID','Webhook ID','状態',
  '保管しているPC','保管場所(ファイル名)',
  '用途【手入力】','担当【手入力】','備考【手入力】','最終確認日(JST)'
];
var WEBHOOK_MACHINE_COLUMNS_ = ['Webhook名','対象チャンネル名','チャンネルID','Webhook ID','状態','保管しているPC','保管場所(ファイル名)','最終確認日(JST)'];

function webhookPlanUpsert(headers, rows, payload) {
  var label = String(payload && payload.label || '').trim();
  if (!label) throw new Error('label_required');
  var columns = {};
  WEBHOOK_MACHINE_COLUMNS_.forEach(function(name) { columns[name] = cloudColumn(headers, name, true); });
  var updates = [], appendRows = [], missing = [], seen = {};
  var states = { alive: '生存', dead: '失効', error: '未確認' };
  (payload && Array.isArray(payload.webhooks) ? payload.webhooks : []).forEach(function(item) {
    var id = String(item.webhookId == null ? '' : item.webhookId).trim();
    if (!id) return;
    seen[id] = true;
    var index = rows.findIndex(function(row) { return String(row[columns['Webhook ID']] || '').trim() === id; });
    var files = (Array.isArray(item.files) ? item.files : []).map(function(file) {
      return String(file || '').replace(/\\/g, '/').split('/').pop();
    }).filter(Boolean).join(', ');
    var values = {
      'Webhook名': item.name || '', '対象チャンネル名': item.channelName || '',
      'チャンネルID': item.channelId || '', 'Webhook ID': id,
      '状態': states[item.state] || '未確認', '保管しているPC': label,
      '保管場所(ファイル名)': files, '最終確認日(JST)': payload.checkedAt || ''
    };
    if (index < 0) {
      var output = headers.map(function() { return ''; });
      WEBHOOK_MACHINE_COLUMNS_.forEach(function(name) { output[columns[name]] = values[name]; });
      appendRows.push(output); return;
    }
    values['保管しているPC'] = cloudMergeLabels(rows[index][columns['保管しているPC']], label);
    values['保管場所(ファイル名)'] = String(rows[index][columns['保管場所(ファイル名)']] || '');
    files.split(',').map(function(value) { return value.trim(); }).filter(Boolean).forEach(function(file) {
      values['保管場所(ファイル名)'] = cloudMergeLabels(values['保管場所(ファイル名)'], file);
    });
    WEBHOOK_MACHINE_COLUMNS_.forEach(function(name) {
      if (String(rows[index][columns[name]] == null ? '' : rows[index][columns[name]]) !== String(values[name]))
        updates.push({ rowNumber: index + 2, columnIndex: columns[name] + 1, value: values[name] });
    });
  });
  rows.forEach(function(row, index) {
    var id = String(row[columns['Webhook ID']] || '').trim();
    var labels = String(row[columns['保管しているPC']] || '').split(',').map(function(v) { return v.trim(); });
    if (!id || seen[id] || labels.indexOf(label) < 0) return;
    missing.push(id);
    if (String(row[columns['状態']] || '') !== '未確認') updates.push({ rowNumber: index + 2, columnIndex: columns['状態'] + 1, value: '未確認' });
  });
  return { updates: updates, appendRows: appendRows, missing: missing };
}

function webhookMatchRows(headers, rows, options) {
  options = options || {};
  var names = { name:'Webhook名', channelName:'対象チャンネル名', channelId:'チャンネルID', webhookId:'Webhook ID', state:'状態', pcs:'保管しているPC', files:'保管場所(ファイル名)', purpose:'用途【手入力】', owner:'担当【手入力】', note:'備考【手入力】', checkedAt:'最終確認日(JST)' };
  var columns = {}; Object.keys(names).forEach(function(key) { columns[key] = cloudColumn(headers, names[key], true); });
  var normalize = function(value) { return String(value == null ? '' : value).toLowerCase().replace(/[ \u3000]/g, ''); };
  var query = normalize(options.query), requested = Number(options.limit);
  var limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, Math.floor(requested)) : 50;
  var matches = rows.filter(function(row) {
    if (!query) return true;
    return ['name','channelName','channelId','webhookId'].some(function(key) { return normalize(row[columns[key]]).indexOf(query) >= 0; });
  });
  return { count: Math.min(matches.length, limit), truncated: matches.length > limit, rows: matches.slice(0, limit).map(function(row) {
    var out = {}; Object.keys(columns).forEach(function(key) { out[key] = String(row[columns[key]] == null ? '' : row[columns[key]]); }); return out;
  }) };
}
