/**
 * RevisionRequestCore.js - 修正要望処理の純粋関数ロジック
 * (node --test で実行可能)
 */

/**
 * 修正要望の妥当性を検証する
 * @param {Object} revision - { items: [{ what, qty, note, unitPrice }], dueHint }
 * @returns {{ ok: boolean, errors: string[] }}
 */
function RevisionRequest_validate(revision) {
  var errors = [];
  if (!revision || typeof revision !== 'object') {
    return { ok: false, errors: ['REVISION_EMPTY'] };
  }
  var items = Array.isArray(revision.items) ? revision.items : [];
  if (items.length === 0) {
    errors.push('ITEMS_EMPTY');
  }

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || typeof item !== 'object') {
      errors.push('ITEM_INVALID_' + i);
      continue;
    }
    var what = String(item.what || item.name || '').trim();
    if (!what) {
      errors.push('ITEM_NAME_EMPTY_' + i);
    }
    var qty = Number(item.qty);
    if (isNaN(qty) || qty <= 0) {
      errors.push('ITEM_QTY_INVALID_' + i);
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors
  };
}

/**
 * デザイナー向け依頼メッセージを組み立てる
 * @param {Object} revision - { items: [{ what, qty, note }], dueHint }
 * @param {Object} caseInfo - { caseName, clientName, ... }
 * @returns {{ ok: boolean, message: string, missing: string[] }}
 */
function RevisionRequest_buildDesignerMessage(revision, caseInfo) {
  var missing = [];
  caseInfo = caseInfo || {};
  var caseName = String(caseInfo.caseName || '').trim();
  if (!caseName) {
    missing.push('caseName');
  }

  var val = RevisionRequest_validate(revision);
  if (!val.ok) {
    if (val.errors.includes('ITEMS_EMPTY')) {
      missing.push('items');
    } else {
      missing.push('items_invalid');
    }
  }

  var dueHint = String((revision && revision.dueHint) || '').trim();
  if (!dueHint) {
    missing.push('dueHint');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      message: '',
      missing: missing
    };
  }

  var items = Array.isArray(revision.items) ? revision.items : [];
  var clientName = String(caseInfo.clientName || '').trim();

  var lines = [];
  lines.push('【パース・デザイン修正依頼】');
  lines.push('案件名: ' + caseName + (clientName ? ' (' + clientName + ' 様)' : ''));
  lines.push('希望期日: ' + dueHint);
  lines.push('');
  lines.push('■ 修正要望明細:');
  items.forEach(function (it, idx) {
    var what = String(it.what || it.name || '').trim();
    var qty = Number(it.qty) || 1;
    var note = String(it.note || '').trim();
    var line = (idx + 1) + '. ' + what + ' (数量: ' + qty + ')';
    if (note) {
      line += ' - ' + note;
    }
    lines.push(line);
  });
  lines.push('');
  lines.push('いつものテンプレで補足し作成をお願いいたします。');
  lines.push('ご不明点や懸念点がありましたらお知らせください。');

  return {
    ok: true,
    message: lines.join('\n'),
    missing: []
  };
}

/**
 * 見積に修正要望を反映し再計算する
 * @param {Object} estimate - { lines: [{ name, qty, unitPrice }], taxRate }
 * @param {Object} revision - { items: [{ what, qty, unitPrice, note }] }
 * @returns {{
 *   estimate: Object,
 *   changed: boolean,
 *   delta: { taxExTotal: number, tax: number, taxInTotal: number },
 *   applied: Array<{ name: string, qty: number, unitPrice: number, mode: 'added' | 'incremented' }>
 * }}
 */
function RevisionRequest_applyToEstimate(estimate, revision) {
  if (!estimate || typeof estimate !== 'object') {
    estimate = { lines: [], taxRate: 0.1 };
  }
  var taxRate = typeof estimate.taxRate === 'number' ? estimate.taxRate : 0.1;
  var origLines = Array.isArray(estimate.lines) ? estimate.lines : [];

  var items = (revision && Array.isArray(revision.items)) ? revision.items : [];
  // 有効な明細を抽出（qty > 0 かつ what があるもの）
  var validItems = items.filter(function (it) {
    return it && typeof it === 'object' && String(it.what || it.name || '').trim() && Number(it.qty) > 0;
  });

  if (validItems.length === 0) {
    var curEx = 0;
    origLines.forEach(function (l) {
      curEx += (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    });
    var curTax = Math.floor(curEx * taxRate);
    var curIn = curEx + curTax;
    return {
      estimate: {
        lines: origLines.map(function (l) { return Object.assign({}, l); }),
        taxRate: taxRate,
        taxExTotal: curEx,
        tax: curTax,
        taxInTotal: curIn
      },
      changed: false,
      delta: { taxExTotal: 0, tax: 0, taxInTotal: 0 },
      applied: []
    };
  }

  // 元の合計
  var prevEx = 0;
  var newLines = origLines.map(function (l) {
    var line = Object.assign({}, l);
    line.name = String(line.name || '').trim();
    line.qty = Number(line.qty) || 0;
    line.unitPrice = Number(line.unitPrice) || 0;
    prevEx += line.qty * line.unitPrice;
    return line;
  });
  var prevTax = Math.floor(prevEx * taxRate);
  var prevIn = prevEx + prevTax;

  var applied = [];

  validItems.forEach(function (item) {
    var targetName = String(item.what || item.name || '').trim();
    var addQty = Number(item.qty) || 0;
    var unitPrice = item.unitPrice != null ? Number(item.unitPrice) : null;

    var found = false;
    for (var i = 0; i < newLines.length; i++) {
      if (newLines[i].name === targetName) {
        newLines[i].qty += addQty;
        if (unitPrice != null && !isNaN(unitPrice)) {
          newLines[i].unitPrice = unitPrice;
        }
        applied.push({
          name: targetName,
          qty: addQty,
          unitPrice: newLines[i].unitPrice,
          mode: 'incremented'
        });
        found = true;
        break;
      }
    }

    if (!found) {
      var price = (unitPrice != null && !isNaN(unitPrice)) ? unitPrice : 0;
      newLines.push({
        name: targetName,
        qty: addQty,
        unitPrice: price,
        note: String(item.note || '').trim()
      });
      applied.push({
        name: targetName,
        qty: addQty,
        unitPrice: price,
        mode: 'added'
      });
    }
  });

  // 新合計
  var newEx = 0;
  newLines.forEach(function (l) {
    newEx += l.qty * l.unitPrice;
  });
  var newTax = Math.floor(newEx * taxRate);
  var newIn = newEx + newTax;

  var deltaEx = newEx - prevEx;
  var deltaTax = newTax - prevTax;
  var deltaIn = newIn - prevIn;
  var isChanged = applied.length > 0 && (deltaEx !== 0 || deltaIn !== 0 || applied.some(function (a) { return a.mode === 'added'; }));

  return {
    estimate: {
      lines: newLines,
      taxRate: taxRate,
      taxExTotal: newEx,
      tax: newTax,
      taxInTotal: newIn
    },
    changed: isChanged,
    delta: {
      taxExTotal: deltaEx,
      tax: deltaTax,
      taxInTotal: deltaIn
    },
    applied: applied
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RevisionRequest_validate: RevisionRequest_validate,
    RevisionRequest_buildDesignerMessage: RevisionRequest_buildDesignerMessage,
    RevisionRequest_applyToEstimate: RevisionRequest_applyToEstimate
  };
}
