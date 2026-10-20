/**
 * 施工ノウハウの図解モジュール連携。
 * 台帳行の source 列に module:<GoogleスライドID> がある場合、
 * 施工手順書 Slides にモジュールの図解スライド（表紙除く）を取り込む。
 */

/** source 文字列から Google スライドのファイル ID を抽出する（純関数）。 */
function ConstructionKnowhow_moduleId(row) {
  if (!row || typeof row.source !== 'string') return '';
  const m = row.source.match(/module:([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : '';
}

/** rows のうち moduleId を持つ行だけを抽出する。 */
function ConstructionKnowhow_moduleRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(function (r) {
    return Boolean(ConstructionKnowhow_moduleId(r));
  });
}

/**
 * モジュールスライドを開き、表紙を除く全スライドを末尾に追加する。
 * 追加前に区切りスライド1枚を挿入する。
 * 失敗（権限・ID無効）時は例外を投げず { ok: false, id, error } を返す。
 */
function ConstructionKnowhow_appendModuleSlides(pres, row, opts) {
  opts = opts || {};
  const id = ConstructionKnowhow_moduleId(row);
  if (!id) {
    const err = 'no moduleId';
    console.warn('ConstructionKnowhow_appendModuleSlides failed: ' + err, row);
    return { ok: false, id: '', error: err };
  }

  try {
    const modulePres = SlidesApp.openById(id);
    const slides = modulePres.getSlides();
    const slidesToAdd = slides.slice(1);

    // 区切りスライド1枚の挿入
    const title = '[' + (row && row.id ? row.id : '') + '] ' + (row && row.title ? row.title : '');
    const url = 'https://docs.google.com/presentation/d/' + id + '/edit';
    const bodyText = '以下は図解モジュール（最新版: ' + url + '）';

    if (typeof _cp_addKnowhowTextSlides === 'function') {
      _cp_addKnowhowTextSlides(pres, title, bodyText);
    } else {
      const slide = pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);
      if (typeof _cp_addPageTitle === 'function') {
        _cp_addPageTitle(slide, 'KH', title);
      } else {
        try { slide.insertTextBox(title, 50, 20, 660, 34); } catch (e) {}
      }
      if (typeof _cp_addPlainText === 'function') {
        _cp_addPlainText(slide, 30, 70, 660, 310, bodyText, { fontSize: 11 });
      } else {
        try { slide.insertTextBox(bodyText, 30, 70, 660, 310); } catch (e) {}
      }
    }

    const linkingMode = (SlidesApp.SlideLinkingMode && SlidesApp.SlideLinkingMode.NOT_LINKED) || 'NOT_LINKED';
    slidesToAdd.forEach(function (slide) {
      pres.appendSlide(slide, linkingMode);
    });

    return { ok: true, id: id, added: slidesToAdd.length };
  } catch (e) {
    const errorMsg = String(e && e.message ? e.message : e);
    console.warn('ConstructionKnowhow_appendModuleSlides failed for id ' + id + ':', errorMsg);
    return { ok: false, id: id, error: errorMsg };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ConstructionKnowhow_moduleId: ConstructionKnowhow_moduleId,
    ConstructionKnowhow_moduleRows: ConstructionKnowhow_moduleRows,
    ConstructionKnowhow_appendModuleSlides: ConstructionKnowhow_appendModuleSlides
  };
}
