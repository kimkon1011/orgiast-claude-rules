// アクティブなドキュメントを取得（なければ新規作成）
var doc;
if (app.documents.length > 0) {
    doc = app.activeDocument;
} else {
    doc = app.documents.add(DocumentColorSpace.CMYK, 800, 600);
}

// 使用するカラーの定義（CMYK）
var mainColor = new CMYKColor();
mainColor.cyan = 100;
mainColor.magenta = 85;
mainColor.yellow = 10;
mainColor.black = 0;

var accentColor = new CMYKColor();
accentColor.cyan = 0;
accentColor.magenta = 45;
accentColor.yellow = 100;
accentColor.black = 0;

var whiteColor = new CMYKColor();
whiteColor.cyan = 0;
whiteColor.magenta = 0;
whiteColor.yellow = 0;
whiteColor.black = 0;

// アートボードの中心座標を取得
var artboard = doc.artboards[doc.artboards.getActiveArtboardIndex()];
var rect = artboard.artboardRect; // [left, top, right, bottom]
var artboardWidth = rect[2] - rect[0];
var artboardHeight = rect[1] - rect[3];
var centerX = rect[0] + (artboardWidth / 2);
var topY = rect[1] - 100;

// 1. ベースの背景プレート（看板枠）を作成
var plateWidth = 650;
var plateHeight = 140;
var plateLeft = centerX - (plateWidth / 2);
var plateTop = topY;

var bgPlate = doc.pathItems.rectangle(plateTop, plateLeft, plateWidth, plateHeight);
bgPlate.fillColor = mainColor;
bgPlate.stroked = false;

// 2. 下部のアクセントラインを作成
var lineThickness = 6;
var lineTop = plateTop - plateHeight + lineThickness;
var accentLine = doc.pathItems.rectangle(lineTop, plateLeft, plateWidth, lineThickness);
accentLine.fillColor = accentColor;
accentLine.stroked = false;

// 3. メイン見出しテキストを作成
var mainTextFrame = doc.textFrames.add();
mainTextFrame.contents = "新製品発表ブース";

// テキスト属性の設定（文字サイズ、カラー、トラッキング）
var mainRange = mainTextFrame.textRange;
mainRange.characterAttributes.size = 48;
mainRange.characterAttributes.fillColor = whiteColor;
mainRange.characterAttributes.tracking = 150; // 文字間隔を広げて高級感を出す
mainRange.paragraphAttributes.justification = Justification.CENTER;

// メインテキストの位置調整（プレートの中央）
mainTextFrame.left = centerX - (mainTextFrame.width / 2);
mainTextFrame.top = plateTop - 25;

// 4. サブ見出し（英語表記）テキストを作成
var subTextFrame = doc.textFrames.add();
subTextFrame.contents = "NEW PRODUCTS EXHIBITION";

// サブテキスト属性の設定
var subRange = subTextFrame.textRange;
subRange.characterAttributes.size = 16;
subRange.characterAttributes.fillColor = accentColor;
subRange.characterAttributes.tracking = 300;
subRange.paragraphAttributes.justification = Justification.CENTER;

// サブテキストの位置調整
subTextFrame.left = centerX - (subTextFrame.width / 2);
subTextFrame.top = mainTextFrame.top - mainTextFrame.height - 10;

// 画面を更新して変更を反映
app.redraw();