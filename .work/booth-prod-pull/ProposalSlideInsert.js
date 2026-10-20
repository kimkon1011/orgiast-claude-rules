/** 既存の提案書の指定ページ直後に、PNG 画像を中心としたスライドを追加する。 */
function ProposalSlide_insertImageSlide(args) {
  args = args || {};
  ['presentationId', 'afterSlideContainsText', 'imageFileId', 'title'].forEach(function (key) {
    if (typeof args[key] !== 'string' || !args[key].trim()) {
      throw new Error(key + ' is required');
    }
  });
  ['subtitle', 'note'].forEach(function (key) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw new Error(key + ' must be a string');
    }
  });
  const captions = args.captions === undefined ? [] : args.captions;
  if (!Array.isArray(captions) || captions.length > 2 ||
      captions.some(function (text) { return typeof text !== 'string'; })) {
    throw new Error('captions must contain zero, one or two strings');
  }
  const titleColor = args.titleColor === undefined ? '#1B5E3A' : args.titleColor;
  if (!/^#[0-9a-f]{6}$/i.test(titleColor)) throw new Error('invalid titleColor');
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
    throw new Error('dryRun must be a boolean');
  }

  const presentation = SlidesApp.openById(args.presentationId);
  const slides = presentation.getSlides();
  const anchorIndex = slides.findIndex(function (slide) {
    return _ProposalSlide_texts(slide).some(function (text) {
      return text.indexOf(args.afterSlideContainsText) !== -1;
    });
  });
  if (anchorIndex < 0) throw new Error('anchor slide not found');
  const insertedIndex = anchorIndex + 1;
  const pageWidth = presentation.getPageWidth();
  const pageHeight = presentation.getPageHeight();
  const next = slides[insertedIndex];
  // Slides のテキスト末尾の段落改行だけを除去し、空白を含むタイトル自体は保持する。
  const alreadyExists = !!next && _ProposalSlide_texts(next).some(function (text) {
    return text.replace(/\n$/, '') === args.title.replace(/\n$/, '');
  });
  if (alreadyExists && !args.dryRun) {
    const image = next.getImages()[0];
    Logger.log('ProposalSlide: already exists ' + next.getObjectId());
    return {
      slideObjectId: next.getObjectId(), insertedIndex: insertedIndex, anchorIndex: anchorIndex,
      pageWidth: pageWidth, pageHeight: pageHeight,
      imageSize: image ? { w: image.getWidth(), h: image.getHeight(), left: image.getLeft(), top: image.getTop() } : null,
      alreadyExists: true
    };
  }

  // PNG の IHDR を読むため、dryRun でも一時スライドや一時ファイルを作らない。
  const blob = DriveApp.getFileById(args.imageFileId).getBlob();
  const pixels = _ProposalSlide_pngSize(blob);
  const margin = pageWidth * 0.04;
  const contentWidth = pageWidth - 2 * margin;
  const titleHeight = pageHeight * 0.09;
  const subtitleHeight = pageHeight * 0.06;
  const gap = pageHeight * 0.015;
  const captionHeight = captions.length ? Math.max(pageHeight * 0.10, 38) : 0;
  const noteHeight = args.note ? Math.max(pageHeight * 0.08, 34) : 0;
  const noteTop = pageHeight - margin - noteHeight;
  const imageTop = margin + titleHeight + subtitleHeight + gap;
  const maxImageHeight = noteTop - imageTop - captionHeight -
    (captions.length ? gap : 0) - (args.note ? gap : 0);
  if (contentWidth <= 0 || maxImageHeight <= 0 || titleHeight < 34 || subtitleHeight < 23) {
    throw new Error('page is too small for the requested layout');
  }
  const scale = Math.min(contentWidth / pixels.w, maxImageHeight / pixels.h);
  const imageSize = {
    w: pixels.w * scale, h: pixels.h * scale,
    left: (pageWidth - pixels.w * scale) / 2, top: imageTop
  };
  const result = {
    slideObjectId: null, insertedIndex: insertedIndex, anchorIndex: anchorIndex,
    pageWidth: pageWidth, pageHeight: pageHeight, imageSize: imageSize,
    alreadyExists: alreadyExists
  };
  if (args.dryRun) {
    Logger.log('ProposalSlide: dryRun index=' + insertedIndex);
    return result;
  }

  const slide = presentation.insertSlide(insertedIndex, SlidesApp.PredefinedLayout.BLANK);
  try {
    _ProposalSlide_addText(slide, args.title, margin, margin, contentWidth, titleHeight, 24, titleColor, true, false);
    if (args.subtitle) {
      _ProposalSlide_addText(slide, args.subtitle, margin, margin + titleHeight,
        contentWidth, subtitleHeight, 13, '#555555', false, false);
    }
    const image = slide.insertImage(blob);
    image.setWidth(imageSize.w).setHeight(imageSize.h).setLeft(imageSize.left).setTop(imageSize.top);
    const captionTop = imageTop + imageSize.h + gap;
    captions.forEach(function (caption, i) {
      const width = captions.length === 1 ? contentWidth : (contentWidth - gap) / 2;
      _ProposalSlide_addText(slide, caption, margin + i * (width + gap), captionTop,
        width, captionHeight, 11, '#333333', false, captions.length === 1);
    });
    if (args.note) {
      _ProposalSlide_addText(slide, args.note, margin, noteTop,
        contentWidth, noteHeight, 9, '#888888', false, false);
    }
    result.slideObjectId = slide.getObjectId();
    presentation.saveAndClose();
  } catch (error) {
    // 途中までのタイトルだけを残して、再実行が成功扱いになるのを防ぐ。
    try {
      slide.remove();
      presentation.saveAndClose();
    } catch (cleanupError) {
      throw new Error(String(error) + '; slide cleanup failed: ' + String(cleanupError));
    }
    throw error;
  }
  Logger.log('ProposalSlide: inserted ' + result.slideObjectId + ' index=' + insertedIndex);
  return result;
}

/** 通常のシェイプと、入れ子のグループ内のシェイプを検索対象にする。 */
function _ProposalSlide_texts(slide) {
  const texts = slide.getShapes().map(function (shape) { return shape.getText().asString(); });
  function visit(group) {
    group.getChildren().forEach(function (element) {
      const type = element.getPageElementType();
      if (type === SlidesApp.PageElementType.SHAPE) texts.push(element.asShape().getText().asString());
      else if (type === SlidesApp.PageElementType.GROUP) visit(element.asGroup());
    });
  }
  slide.getGroups().forEach(visit);
  return texts;
}

/** GAS の signed byte 配列から PNG の幅・高さ（unsigned big-endian）を読む。 */
function _ProposalSlide_pngSize(blob) {
  const bytes = blob.getBytes();
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some(function (value, i) { return (bytes[i] & 255) !== value; }) ||
      bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new Error('imageFileId must refer to a PNG image');
  }
  function uint32(offset) {
    return (bytes[offset] & 255) * 16777216 + (bytes[offset + 1] & 255) * 65536 +
      (bytes[offset + 2] & 255) * 256 + (bytes[offset + 3] & 255);
  }
  const size = { w: uint32(16), h: uint32(20) };
  if (uint32(8) !== 13 || size.w <= 0 || size.h <= 0) throw new Error('invalid PNG dimensions');
  return size;
}

/** 固定フォントと余裕のある枠で描画。例外を隠す既存ヘルパーには依存しない。 */
function _ProposalSlide_addText(slide, text, x, y, w, h, fontSize, color, bold, centered) {
  if (!text) return;
  const shape = slide.insertTextBox(text, x, y, w, h);
  shape.setContentAlignment(SlidesApp.ContentAlignment.TOP);
  const range = shape.getText();
  range.getTextStyle().setFontSize(fontSize).setBold(bold).setForegroundColor(color);
  range.getParagraphStyle()
    .setParagraphAlignment(centered ? SlidesApp.ParagraphAlignment.CENTER : SlidesApp.ParagraphAlignment.START)
    .setSpaceAbove(0).setSpaceBelow(0);
}
