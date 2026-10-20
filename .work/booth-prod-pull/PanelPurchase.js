var PANEL_PURCHASE_TITLE_PREFIX = '🛒 買う物の URL と個数をここに貼る';

function PanelPurchase_findSection(panelSheet) {
  var lastRow = panelSheet ? panelSheet.getLastRow() : 0;
  if (lastRow < 6) return -1;
  var values = panelSheet.getRange(6, 1, lastRow - 5, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').indexOf(PANEL_PURCHASE_TITLE_PREFIX) === 0) return i + 6;
  }
  return -1;
}

function PanelPurchase_read(panelSheet) {
  var row = PanelPurchase_findSection(panelSheet);
  return row < 0 ? '' : String(panelSheet.getRange(row + 1, 3).getValue() || '').trim();
}

function PanelPurchase_clear(panelSheet) {
  var row = PanelPurchase_findSection(panelSheet);
  if (row >= 0) panelSheet.getRange(row + 1, 3).clearContent();
}

function _PanelPurchase_nearestDate(year, month, day, today) {
  var candidate = new Date(year, month - 1, day);
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return '';
  var base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (candidate < base) candidate = new Date(year + 1, month - 1, day);
  return String(candidate.getFullYear()) + '/' + String(candidate.getMonth() + 1).padStart(2, '0') + '/' + String(candidate.getDate()).padStart(2, '0');
}

/** 貼り付けテキストを1行1品でパースする。 */
function PanelPurchase_parseLines(text) {
  var items = [], errors = [], today = new Date();
  String(text == null ? '' : text).split(/\r?\n/).forEach(function (original) {
    var normalized = String(original).normalize('NFKC').trim();
    if (!normalized || /^(#|\/\/)/.test(normalized)) return;
    var line = normalized.replace(/^(?:[・*\-]|\d+[.)])\s*/, '').trim();
    var work = line;
    var url = '';
    var urlMatch = work.match(/https?:\/\/[^\s、,｜|]+/i);
    if (urlMatch) {
      url = urlMatch[0].replace(/[。、)]+$/, '');
      work = work.replace(urlMatch[0], ' ');
    }

    var quantity = 1, quantityFound = false;
    var quantityMatch = work.match(/(?:[×xX*]\s*(\d+)|(\d+)\s*(?:個|本|枚|台|セット|箱|巻|ケース|m)(?![a-zA-Z])|(?:数量|個数|qty)\s*[:：]?\s*(\d+))/i);
    if (quantityMatch) {
      quantity = Number(quantityMatch[1] || quantityMatch[2] || quantityMatch[3]);
      quantityFound = true;
      work = work.replace(quantityMatch[0], ' ');
    }

    var budget = '';
    var budgetMatch = work.match(/(?:[¥￥]\s*([\d,]+)|([\d,]+)\s*円|予算\s*[:：]?\s*([\d,]+))/);
    if (budgetMatch) {
      budget = Number(String(budgetMatch[1] || budgetMatch[2] || budgetMatch[3]).replace(/,/g, ''));
      work = work.replace(budgetMatch[0], ' ');
    }

    var requiredBy = '';
    // 必着/まで/〜 の目印が無い M/D は日付として拾わない。
    // 「A4/2穴」「13/16インチ」のような品名を日付と誤認して品名から消してしまうため。
    var dateMatch = work.match(/(?:必着|納期)\s*[:：]?\s*(?:(\d{4})[\/年])?(\d{1,2})[\/月](\d{1,2})(?:日)?|(?:(\d{4})[\/年])?(\d{1,2})[\/月](\d{1,2})(?:日)?\s*(?:必着|まで)|[〜~]\s*(?:(\d{4})[\/年])?(\d{1,2})[\/月](\d{1,2})(?:日)?/);
    if (dateMatch) {
      var yearRaw = dateMatch[1] || dateMatch[4] || dateMatch[7];
      var year = yearRaw ? Number(yearRaw) : today.getFullYear();
      var month = Number(dateMatch[2] || dateMatch[5] || dateMatch[8]);
      var day = Number(dateMatch[3] || dateMatch[6] || dateMatch[9]);
      requiredBy = yearRaw
        ? _PanelPurchase_nearestDate(year, month, day, new Date(year, 0, 1))
        : _PanelPurchase_nearestDate(year, month, day, today);
      work = work.replace(dateMatch[0], ' ');
    }

    if (!quantityFound) {
      var loneInteger = work.match(/(?:^|\s)(\d+)(?=\s|$)/);
      if (loneInteger) {
        quantity = Number(loneInteger[1]);
        work = work.replace(loneInteger[0], ' ');
      }
    }
    var name = work.replace(/[\/,、｜|]+/g, ' ').replace(/^[\s:：;；()（）\-]+|[\s:：;；()（）\-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!url && !name) errors.push({ line: normalized, reason: 'URL も品名も読み取れませんでした' });
    else items.push({ url: url, name: name, quantity: quantity, budget: budget, requiredBy: requiredBy, raw: normalized });
  });
  return { items: items, errors: errors };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  PanelPurchase_parseLines: PanelPurchase_parseLines,
  PanelPurchase_findSection: PanelPurchase_findSection,
  PANEL_PURCHASE_TITLE_PREFIX: PANEL_PURCHASE_TITLE_PREFIX
};
