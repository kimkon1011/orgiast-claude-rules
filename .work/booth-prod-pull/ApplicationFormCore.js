/**
 * 申込書（ApplicationForm）の生成・検証 純粋関数モジュール。
 * Node.js (test) および GAS の両方から利用可能。
 */

/**
 * 日付を YYYYMMDD または YYYY/MM/DD 等に整形する補助関数
 */
function _AppForm_formatDateYmd(d, sep) {
  if (!d) return '';
  var date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) {
    var m = String(d).match(/^(\d{4})[\/-]?(\d{1,2})[\/-]?(\d{1,2})/);
    if (m) {
      var y = m[1], mo = String(m[2]).padStart(2, '0'), da = String(m[3]).padStart(2, '0');
      return sep !== undefined ? [y, mo, da].join(sep) : y + mo + da;
    }
    return '';
  }
  var y = date.getFullYear();
  var mo = String(date.getMonth() + 1).padStart(2, '0');
  var da = String(date.getDate()).padStart(2, '0');
  return sep !== undefined ? [y, mo, da].join(sep) : '' + y + mo + da;
}

/**
 * 申込書ファイル名
 * 【申込書】<展示会名>_<顧客名>_<YYYYMMDD>.pdf
 */
function ApplicationForm_fileName(caseInfo, today) {
  caseInfo = caseInfo || {};
  var show = String(caseInfo.eventName || caseInfo.caseName || '').trim() || '展示会';
  var client = String(caseInfo.clientName || '').trim() || '顧客';
  var dateStr = _AppForm_formatDateYmd(today || new Date(), '');
  return '【申込書】' + show + '_' + client + '_' + dateStr + '.pdf';
}

/**
 * 支払条件文を生成
 * 「本番 1 ヶ月前の月末と申込書受領月の月末の早い方に前金で半額、残りは納品後の翌月末。電気代・特急料金は見積外となります。」
 */
function ApplicationForm_buildPaymentTerms(caseInfo, today) {
  return '本番 1 ヶ月前の月末と申込書受領月の月末の早い方に前金で半額、残りは納品後の翌月末。※電気代・特急料金は見積外となります。';
}

/**
 * キャンセル規定文（デフォルト）
 */
var APPLICATION_DEFAULT_CANCEL_POLICY =
  '【キャンセル規定】\n' +
  '・お申込み〜本番31日前まで: お見積金額（税込）の30%\n' +
  '・本番30日前〜15日前まで: お見積金額（税込）の50%\n' +
  '・本番14日前〜前日まで: お見積金額（税込）の80%\n' +
  '・本番当日: お見積金額（税込）の100%\n' +
  '※既に発生した実費・手配費用がある場合は、上記に加えて全額ご請求となります。';

/**
 * 申込書のモデル構築
 * @param {Object} estimate - 見積情報 { items: [...], totalExcludingTax, consumptionTax, totalIncludingTax, cancelPolicy }
 * @param {Object} caseInfo - 案件情報 { clientName, contactName, address, tel, email, eventName, caseName, startDate, endDate }
 * @param {Date|string} today - 作成日
 */
function ApplicationForm_buildModel(estimate, caseInfo, today) {
  estimate = estimate || {};
  caseInfo = caseInfo || {};
  var d = today ? (today instanceof Date ? today : new Date(today)) : new Date();

  var clientName = String(caseInfo.clientName || '').trim();
  var contactName = String(caseInfo.contactName || caseInfo.recipientContact || '').trim();
  var address = String(caseInfo.address || '').trim();
  var tel = String(caseInfo.tel || caseInfo.phone || '').trim();
  var email = String(caseInfo.email || caseInfo.clientEmail || '').trim();

  var exhibitionName = String(caseInfo.eventName || caseInfo.caseName || '').trim();
  var sDate = _AppForm_formatDateYmd(caseInfo.startDate, '/');
  var eDate = _AppForm_formatDateYmd(caseInfo.endDate, '/');
  var period = sDate && eDate ? (sDate === eDate ? sDate : sDate + ' 〜 ' + eDate) : (sDate || eDate || String(caseInfo.period || '').trim());

  var items = Array.isArray(estimate.items) ? estimate.items : [];
  var itemsDetail = items.map(function (it, idx) {
    var name = String(it.itemName || it.name || '').trim();
    var spec = String(it.spec || it.content || '').trim();
    var qty = Number(it.qty) || 1;
    var unit = String(it.qtyUnit || it.unit || '式').trim();
    var unitPrice = Number(it.unitPrice) || 0;
    var amount = Number(it.amount != null ? it.amount : (qty * unitPrice));
    return {
      index: idx + 1,
      category: String(it.category || '').trim(),
      name: name,
      spec: spec,
      qty: qty,
      unit: unit,
      unitPrice: unitPrice,
      amount: amount,
      note: String(it.note || '').trim()
    };
  });

  // 金額計算（estimate に明示されていればそれを優先、なければ明細合算）
  var totalExcludingTax = estimate.totalExcludingTax != null ? Number(estimate.totalExcludingTax) : itemsDetail.reduce(function (sum, it) { return sum + it.amount; }, 0);
  var consumptionTax = estimate.consumptionTax != null ? Number(estimate.consumptionTax) : Math.round(totalExcludingTax * 0.1);
  var totalIncludingTax = estimate.totalIncludingTax != null ? Number(estimate.totalIncludingTax) : (totalExcludingTax + consumptionTax);

  var paymentTerms = estimate.paymentTerms || ApplicationForm_buildPaymentTerms(caseInfo, d);
  var cancelPolicy = estimate.cancelPolicy || APPLICATION_DEFAULT_CANCEL_POLICY;
  var applicationDate = _AppForm_formatDateYmd(d, '/');

  return {
    clientName: clientName,
    contactName: contactName,
    address: address,
    tel: tel,
    email: email,
    exhibitionName: exhibitionName,
    period: period,
    items: itemsDetail,
    totalExcludingTax: totalExcludingTax,
    consumptionTax: consumptionTax,
    totalIncludingTax: totalIncludingTax,
    paymentTerms: paymentTerms,
    cancelPolicy: cancelPolicy,
    applicationDate: applicationDate
  };
}

/**
 * 申込書モデルの検証
 * 1. 税込合計が見積の税込合計と 1 円でも違えば errors に AMOUNT_MISMATCH(見積 X / 申込書 Y)
 * 2. 必須欄が空なら MISSING_<field>
 * 必須欄: clientName, exhibitionName, totalIncludingTax
 */
function ApplicationForm_validate(model, estimate) {
  model = model || {};
  estimate = estimate || {};
  var errors = [];

  // 金額検証: estimate.totalIncludingTax (または estimate.total) との厳密一致
  var estimateTotal = estimate.totalIncludingTax != null ? Number(estimate.totalIncludingTax) : (estimate.total != null ? Number(estimate.total) : null);
  var modelTotal = Number(model.totalIncludingTax);

  if (estimateTotal !== null && !isNaN(estimateTotal)) {
    if (Math.round(modelTotal) !== Math.round(estimateTotal)) {
      errors.push('AMOUNT_MISMATCH(見積 ' + estimateTotal + ' / 申込書 ' + modelTotal + ')');
    }
  }

  // 必須欄チェック
  if (!String(model.clientName || '').trim()) errors.push('MISSING_clientName');
  if (!String(model.exhibitionName || '').trim()) errors.push('MISSING_exhibitionName');
  if (model.totalIncludingTax == null || isNaN(model.totalIncludingTax) || model.totalIncludingTax <= 0) {
    errors.push('MISSING_totalIncludingTax');
  }

  return {
    ok: errors.length === 0,
    errors: errors
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ApplicationForm_fileName: ApplicationForm_fileName,
    ApplicationForm_buildPaymentTerms: ApplicationForm_buildPaymentTerms,
    ApplicationForm_buildModel: ApplicationForm_buildModel,
    ApplicationForm_validate: ApplicationForm_validate,
    APPLICATION_DEFAULT_CANCEL_POLICY: APPLICATION_DEFAULT_CANCEL_POLICY
  };
}
