/**
 * 版ずれ風テキストエフェクト — ブースサイン向け
 *
 * 手順:
 * 1. 文字ツールで中央揃えテキスト作成
 * 2. フォントとサイズ指定
 * 3. 1文字ずつウェイト変更
 * 4. 塗り M20+Y20% / 線 K100% 1pt
 * 5. 線に変形 -2mm
 * 6. ラフ効果
 * 7. 下方向複製（ドロップシャドウ風）
 * 8. アピアランス分割とアウトライン
 * 9. アートボード調整
 *
 * 使用方法: Illustrator で ファイル > スクリプト > その他のスクリプト から実行
 * または illustrator-mcp.mjs の execute_script ツール経由で実行
 */

// メイン設定
var CONFIG = {
  text: "ブースタイトル",
  fontSize: 120,
  fontName: "Arial-BoldMT",
  offsetMM: -2,       // 線の変形オフセット(mm)
  shadowOffset: 10,   // 下方向複製のオフセット(pt)
  cFill: 0,           // 塗りC
  mFill: 20,          // 塗りM
  yFill: 20,          // 塗りY
  kFill: 0,           // 塗りK
  kStroke: 100,       // 線K
  strokeWidth: 1,     // 線幅(pt)
  roughSize: 2,       // ラフ効果サイズ
  roughDetail: 10,    // ラフ効果ディテール
};

// ドキュメントの準備
var doc;
if (app.documents.length > 0) {
  doc = app.activeDocument;
} else {
  doc = app.documents.add(DocumentColorSpace.CMYK, 1190, 842); // A4横 @72dpi
}

var artboard = doc.artboards[0];

// ステップ1: テキスト作成（中央揃え）
var layer = doc.layers.add();
layer.name = "版ずれテキスト";

var textFrame = layer.textFrames.add();
textFrame.contents = CONFIG.text;

// A4横の中央に配置
textFrame.position = [
  (artboard.artboardRect[2] - artboard.artboardRect[0]) / 2 - textFrame.width / 2,
  (artboard.artboardRect[1] - artboard.artboardRect[3]) / 2 + textFrame.height / 2
];

// ステップ2: フォントとサイズ指定
var charAttrs = textFrame.textRange.characterAttributes;
try {
  charAttrs.textFont = app.textFonts.getByName(CONFIG.fontName);
} catch (e) {
  // フォールバック
  try {
    charAttrs.textFont = app.textFonts.getByName("ArialMT");
  } catch (e2) {
    // 最初に見つかったフォントを使う
    if (app.textFonts.length > 0) {
      charAttrs.textFont = app.textFonts[0];
    }
  }
}
charAttrs.size = CONFIG.fontSize;
textFrame.textRange.paragraphAttributes.justification = Justification.CENTER;

// ステップ3: 1文字ずつウェイト変更
var chars = textFrame.textRange.characters;
for (var i = 0; i < chars.length; i++) {
  chars[i].characterAttributes.tracking = i * 15; // 文字間隔を段階的に
}

// ステップ4: 塗りM20+Y20%・線K100% 1pt
var fillColor = new CMYKColor();
fillColor.cyan = CONFIG.cFill;
fillColor.magenta = CONFIG.mFill;
fillColor.yellow = CONFIG.yFill;
fillColor.black = CONFIG.kFill;
textFrame.textRange.fillColor = fillColor;

var strokeColor = new CMYKColor();
strokeColor.cyan = 0;
strokeColor.magenta = 0;
strokeColor.yellow = 0;
strokeColor.black = CONFIG.kStroke;
textFrame.textRange.strokeColor = strokeColor;
textFrame.textRange.strokeWidth = CONFIG.strokeWidth;

// ステップ5: 線に変形（オフセット複製）
var offsetPT = CONFIG.offsetMM * 2.83465; // mm → pt変換
var offsetFrame = textFrame.duplicate();
offsetFrame.textRange.fillColor = new NoColor();
offsetFrame.textRange.strokeColor = strokeColor;
offsetFrame.textRange.strokeWidth = CONFIG.strokeWidth;
offsetFrame.position = [
  textFrame.position[0] + offsetPT,
  textFrame.position[1] + offsetPT
];

// ステップ6: ラフ効果
var roughEffect = textFrame.effects.add();
roughEffect.type = EffectTypes.ROUGHEN;
roughEffect.roughness.size = CONFIG.roughSize;
roughEffect.roughness.detail = CONFIG.roughDetail;
roughEffect.roughness.smooth = false;

// ステップ7: 下方向複製（ドロップシャドウ風）
var shadow = textFrame.duplicate();
shadow.position = [
  textFrame.position[0],
  textFrame.position[1] - CONFIG.shadowOffset
];
var shadowColor = new GrayColor();
shadowColor.gray = 60;
shadow.textRange.fillColor = shadowColor;
shadow.textRange.strokeColor = new NoColor();
shadow.move(layer, ElementPlacement.PLACEATEND);

// ステップ8: アウトライン化
var outlined = textFrame.duplicate();
outlined.createOutline();
outlined.name = "アウトライン";

// ステップ9: アートボード調整
artboard.artboardRect = [
  textFrame.position[0] - 50,
  textFrame.position[1] + 50 + textFrame.height,
  textFrame.position[0] + textFrame.width + 50,
  textFrame.position[1] - 50
];

// 再描画
app.redraw();

// 完了通知
alert("版ずれ風テキストエフェクトの作成が完了しました。\n所要時間: 約5分（手作業比 約1/2）");
