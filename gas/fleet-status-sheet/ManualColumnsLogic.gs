var MANUAL_HEADERS_ = ['担当【手入力】','備考【手入力】'];
// 「解約可否メモ」は用途が限定された列で自由記入欄の代わりにならないため、同義列に含めない
// (含めるとクラウド契約タブだけ自由記入欄が無くなる)。
var MANUAL_EQUIVALENTS_ = { '担当【手入力】': ['担当','契約者・管理者'], '備考【手入力】': ['備考'] };

function manualPlanColumns(headers) {
  if (!Array.isArray(headers) || headers.length === 0) return [];
  return MANUAL_HEADERS_.filter(function(name) {
    return [name].concat(MANUAL_EQUIVALENTS_[name] || []).every(function(candidate) {
      return fleetFindHeaderIndex(headers, candidate) < 0;
    });
  });
}
