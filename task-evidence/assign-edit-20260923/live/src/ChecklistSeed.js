/** 当日スタッフ用チェックリストの既定テンプレート。 */

function ChecklistSeed_defaultTemplates() {
  var vehicleUrls = JSON.stringify({
    'デュトロ': 'https://docs.google.com/document/d/1ZsGnj-VCm9t3X_qu8T5qjNX4mE-t0rIhX5c5pw5xW0U/edit',
    'キャラバン': 'https://docs.google.com/document/d/1zvyFisgjhfpCnvNkNFIHSCgCU2Of77y-H0rhbPbOSAg/edit'
  });
  var rows = [
    ['ドライバー','設営前日',1,'【厳守】鍵は絶対に持ち歩かない。どんなときも車を離れるときはキーボックスに入れる','別の人が運転する可能性があるため。短時間でも例外なし。','check','',true,true],
    ['ドライバー','設営前日',2,'乗る車のマニュアルを開いて必読してから乗車する','デュトロ=トラック（地上高2,970mm・軽油）／キャラバン（車高2.5m・ガソリン）。高さ制限のある駐車場・トンネルに入らない','vehicle_doc',vehicleUrls,true,true],
    ['ドライバー','設営前日',3,'駐車したら、駐車場全体の中で車の位置がわかる引きの写真を撮って送る','','photo','',true,true],
    ['ドライバー','設営前日',4,'駐車場の看板（名称・料金表示）の写真を撮って送る','','photo','',true,true],
    ['ドライバー','設営前日',5,'駐車券をダッシュボードに置いた状態の写真を撮って送る','','photo','',true,true]
  ];
  var days = ['設営初日','設営二日目','本番日','撤収日'];
  days.forEach(function (day) {
    rows.push(['ドライバー',day,1,'【厳守】鍵は絶対に持ち歩かない。どんなときも車を離れるときはキーボックスに入れる','別の人が運転する可能性があるため。短時間でも例外なし。','check','',true,true]);
    rows.push(['ドライバー',day,2,'集合場所に到着したら到着報告','','check','',true,true]);
    rows.push(['ドライバー',day,3,'作業終了時に終了報告','','check','',true,true]);
  });
  ['設営前日','設営初日','設営二日目','本番日','撤収日'].forEach(function (day) {
    rows.push(['スタッフ',day,1,'集合場所に到着したら到着報告','','check','',true,true]);
    rows.push(['スタッフ',day,2,'作業終了時に終了報告','','check','',true,true]);
  });
  // プロデューサー: 半日スタッフの解散は Kim に延長相談の要否を確認してから（kim 指示 2026-09-07）。前日以外の全日程、各日の最後に置く
  ['設営初日','設営二日目','本番日','撤収日'].forEach(function (day) {
    rows.push(['プロデューサー',day,90,'【必須】半日スタッフを独断で帰さない。Kimに連絡し延長を相談するか確認してから解散する','半日契約のスタッフの作業が終わっても、その場の判断で帰さない。必ずKimへ連絡し、延長をお願いするかどうかを確認してから解散させる。','check','',true,true]);
  });
  var sheetRows = [];
  if (typeof ChecklistSeedSheet_rows === 'function') {
    sheetRows = ChecklistSeedSheet_rows();
  } else if (typeof require === 'function') {
    sheetRows = require('./ChecklistSeedSheet.js').ChecklistSeedSheet_rows();
  }
  var groupOrder = {};
  var nextGroup = 0;
  return rows.concat(sheetRows || []).map(function (row, index) {
    var key = String(row[0] || '') + '\n' + String(row[1] || '');
    if (!Object.prototype.hasOwnProperty.call(groupOrder, key)) {
      groupOrder[key] = nextGroup++;
    }
    return { row: row, index: index, group: groupOrder[key] };
  }).sort(function (a, b) {
    return a.group - b.group ||
      (Number(a.row[2]) || 0) - (Number(b.row[2]) || 0) ||
      a.index - b.index;
  }).map(function (entry) { return entry.row; });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChecklistSeed_defaultTemplates: ChecklistSeed_defaultTemplates };
}
