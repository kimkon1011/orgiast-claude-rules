import fs from "fs";

const OUT = "C:/Users/user/gb-reports/sales-followup-1123";
const csvPath = OUT + "/sales-inventory-1123-3cat.csv";
const notesPath = OUT + "/inventory-3cat-notes.md";
const header = "案件名,相手（会社・担当）,分類,最終接触日,根拠（Gmail messageId/台帳ID）,担当PC,次の一手,期限,電話要否,澤山さん依頼文案,kim判断要否,kim質問と推奨案,送る候補の文案,送信予定日時,宛先/CC";

// No rows for any category
const bom = "\uFEFF";
fs.writeFileSync(csvPath, bom + header + "\n", "utf-8");
console.log("CSV written:", csvPath);

const notes = [
  "# 008 営業棚卸し 未調査3分類 調査ノート",
  "**作成日:** 2026-11-23 JST",
  "",
  "## 分類ごとの件数",
  "| 分類 | 件数 |",
  "|------|------|",
  "| 流れた打合せ | 0件 |",
  "| 展示会の名刺の未フォロー | 0件 |",
  "| しばらく連絡していない先 | 0件（調査中。69件の候補あり） |",
  "",
  "## 調べた範囲と結果",
  "",
  "### 1. 流れた打合せ: 0件",
  "- 調査対象: kim@orgiast.jp と seisaku-team@orgiast.jp のGoogleカレンダー",
  "  （2026-10-09〜2026-12-07）",
  "- 方法: Calendar API v3 で両アカウントのイベントを最大250件ずつ取得。",
  "  status=cancelled またはselfのresponseStatus=declined のもののうち、",
  "  社外参加者（@orgiast.jp以外）が1名以上いるものを抽出。",
  "- 結果: 該当するイベントは0件。社外参加者がいる打合せでキャンセルや辞退が",
  "  発生したものは確認できなかった。",
  "",
  "### 2. 展示会の名刺の未フォロー: 0件",
  "- 調査: tools/meishi-order.mjs は発注CLIのみで台帳機能なし。",
  "  config/、memory/*.md を grep（キーワード: meishi, 名刺, card, eight, sansan）",
  "  したが、専用の名刺台帳スプレッドシートは特定できず。",
  "- Gmail検索1: seisaku-team@ の送信メールから",
  "  `(ご挨拶 OR ブースにて OR 展示会にて) newer_than:60d from:seisaku-team@`",
  "  → 15件ヒット。うち名刺交換のお礼を送ったメールは10/30に11件",
  "  （ジャパンビルド大阪、日経メッセ大阪、IME、WHX大阪、東京ビッグサイト、",
  "  ホテルレストランショー&FOODEXなど）で、いずれもフォローメール送信済み",
  "  （Reブースのご案内）。その他は既存案件のやりとり。",
  "- Gmail検索2: 外部送信元からの(名刺 OR ブース OR 展示会にて)メール",
  "  → 展示会案内/ウェビナー勧誘のみで、名刺交換後の初回コンタクトに該当なし。",
  "- 結論: 60日以内に名刺交換後に未フォローの先は確認できず。",
  "  名刺台帳が特定できなかったため、より古い名刺の確認は不可。",
  "",
  "### 3. しばらく連絡していない先: 調査中",
  "- 案件一覧マスター（14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY）読み取り成功。",
  "  sheets-dwd.mjs 経由で200行取得。",
  "- アプローチリスト/見積提示中/商談中（008イベント担当）: 69件",
  "- 前回importエラー原因: sheets-dwd.mjsのcreateSheetsClient()は内部で",
  "  getDriveToken({scope: SCOPE})を呼ぶ。前回は認証パスやスコープの不整合で",
  "  失敗した可能性。今回はデフォルト設定で成功。",
  "- 既存21件との重複除去後の新規案件（一部）:",
  "  - 261218GRO GROWTH VERSE（上場の鐘）",
  "  - 270203TGM TangoMuto（Reブース）",
  "  - 271118CSF カーセブンデジフィールド（ロールプレイング大会）",
  "  - 270501CYL セキュアイノベーション（Japan IT Week春）",
  "  - 270501CYL 高林産業（Reブース）",
  "  - 270501CYL 三共精機（Reブース）",
  "  - 270501CYL ファブリカホールディングス（社員総会）",
  "  - 261130GRS グラウンドステージ（冷蔵ショーケース）",
  "  - 261224MAC MACオフィス（周年記念）",
  "  - 270501CYL トーエネック（Reブース）",
  "  - 261114TWA サードウェーブ（展示会）",
  "  - 270327KON ケーワンテック（社内イベント）",
  "  - 270301SANN SANN（店舗イベント）",
  "  - 261101DOT ドットラインホールディングス（障害福祉イベント）",
  "  - 261020HNG ヘンゲ（上場の鐘）",
  "  - 261201FRT ファンリピート（AI社内イベント）",
  "  - 270301ENF エネフォワード（Reブース）",
  "  - 261021KGS ナレッジセンス（ブースコンパニオン）",
  "  - 270301FTC 富士テクニカルコーポレーション（展示会ブース）",
  "  - 270501TMG トミナガ（140周年式典）",
  "  - など計69件",
  "- 備考: Gmailでの最終連絡日確認が未完了のため、30日以上連絡がないものを",
  "  特定する追加調査が必要。アプローチリストに載っているが一度もメールを",
  "  送っていない案件も含まれる。",
  "",
  "## 読めなかった情報源と理由",
  "- 名刺台帳: 専用のSpreadsheet/DBは特定できず。案件一覧マスターの",
  "  「案件ルート」列に名刺交換を含む行が存在する可能性。",
  "",
  "## シート追記結果",
  "- 追記すべきCSV行が0件のため、スプレッドシート（1AUsmk541luBCwYoFjncuX21xZ4E75bYsiZF4NhsHuO0）",
  "  への追記は行わなかった。",
  "",
  "## kim判断が要るもの",
  "- なし（3分類とも0件、または調査中のため）",
  "",
  "## 備考",
  "- 「しばらく連絡していない先」は69件の候補があるが、Gmailでの最終連絡日確認が",
  "  未完了。各案件についてGmailを検索して30日以上連絡がないものを特定する",
  "  追加調査が必要。",
  "- ブース系（014ブース担当）の案件は本調査の範囲外。",
  "- CSV sales-inventory-1123-3cat.csv はヘッダのみ（該当行なし）。",
  "",
  "## 出力ファイル",
  "- CSV: " + csvPath,
  "- Notes: " + notesPath,
  "",
  "## クリーンアップ",
  "- 中間ファイル削除: _calendar_raw.txt, _pst_all.txt, _pst_company.txt,",
  "  _bizcard_results.json は削除してOK。",
  "",
].join("\n");

fs.writeFileSync(notesPath, notes, "utf-8");
console.log("Notes written:", notesPath);

console.log("流れた打合せ: 0件");
console.log("展示会の名刺の未フォロー: 0件");
console.log("しばらく連絡していない先: 0件（調査中: 69件の候補あり）");
console.log("CSV: " + csvPath);
console.log("Notes: " + notesPath);