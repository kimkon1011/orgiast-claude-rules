/** 施工ノウハウの正本。日々の追加・修正・廃止はシートまたは CommandQueue から行う。 */
const _CK_HEADERS = ['ID', '分類', '種別', 'フェーズ', '適用条件', 'タイトル', '本文', '手順(改行区切り)', '出典(案件ID/日付/発言者/資料)', '状態', '登録日', '更新日'];
const _CK_FIELDS = ['id', 'category', 'type', 'phase', 'condition', 'title', 'body', 'steps', 'source', 'status', 'createdAt', 'updatedAt'];

function ConstructionKnowhow_sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('施工ノウハウ');
  if (!sh) sh = ss.insertSheet('施工ノウハウ');
  if (!sh.getLastRow()) sh.getRange(1, 1, 1, _CK_HEADERS.length).setValues([_CK_HEADERS]);
  return sh;
}

function ConstructionKnowhow_read_(sh) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, _CK_FIELDS.length).getValues().map(function (cells) {
    const row = {};
    _CK_FIELDS.forEach(function (key, i) { row[key] = cells[i]; });
    return row;
  });
}

function ConstructionKnowhow_list() {
  return ConstructionKnowhow_read_(ConstructionKnowhow_sheet_()).filter(function (r) { return r.id; });
}

/** 条件評価は純関数。未知・不正な条件は全案件扱いせず不一致にする。 */
function ConstructionKnowhow_matches(condition, caseId, text) {
  if (!String(condition || '').trim()) return true;
  return String(condition).split(/\s+&\s+/).every(function (term) {
    term = term.trim();
    if (term.indexOf('case:') === 0) return term.slice(5).trim() === String(caseId || '') && !!caseId;
    if (term.indexOf('kw:') !== 0) return false;
    const words = term.slice(3).split('|').map(function (s) { return s.trim().normalize('NFC').toLowerCase(); });
    const haystack = String(text || '').normalize('NFC').toLowerCase();
    return words.every(Boolean) && words.some(function (w) { return haystack.indexOf(w) >= 0; });
  });
}

function ConstructionKnowhow_caseText(parsed, extraText) {
  // 固定注入や前回の KH 確認事項で、次回の適用条件が自己成立しないようにする。
  const json = JSON.stringify(parsed || {}, function (key, value) {
    if (/^fixed_|^appliedKnowhowIds$/.test(key)) return undefined;
    if (value && typeof value === 'object' && /^KH-\d+$/.test(value.key || '')) return undefined;
    if (typeof value === 'string' && /^\[KH-\d+\]/.test(value)) return undefined;
    return value;
  });
  return json + '\n' + String(extraText || '');
}

function ConstructionKnowhow_filter(rows, c, parsed, extraText) {
  const text = ConstructionKnowhow_caseText(parsed, extraText);
  return rows.filter(function (r) {
    return (r.status === '有効' || r.status === '要確認') && ConstructionKnowhow_matches(r.condition, c && c.caseId, text);
  });
}

function ConstructionKnowhow_applicable(c, parsedOrNull, extraText) {
  return ConstructionKnowhow_filter(ConstructionKnowhow_list(), c, parsedOrNull, extraText);
}

function ConstructionKnowhow_entry_(entry) {
  const out = {};
  _CK_FIELDS.forEach(function (key, i) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) out[key] = entry[key];
    else if (Object.prototype.hasOwnProperty.call(entry, _CK_HEADERS[i])) out[key] = entry[_CK_HEADERS[i]];
  });
  return out;
}

function ConstructionKnowhow_validate_(entry) {
  ['category', 'title', 'body'].forEach(function (key) {
    if (!String(entry[key] || '').trim()) throw new Error('施工ノウハウ: ' + key + ' は必須です');
  });
  if (['絶対ルール', '標準手順', '注意', '体裁'].indexOf(entry.type) < 0) throw new Error('種別が不正です');
  if (['設営', '撤去', '共通'].indexOf(entry.phase) < 0) throw new Error('フェーズが不正です');
  if (['有効', '要確認', '廃止'].indexOf(entry.status) < 0) throw new Error('状態が不正です');
  if (entry.condition && !String(entry.condition).split(/\s+&\s+/).every(function (s) {
    return /^(kw:[^|&]+(?:\|[^|&]+)*|case:[^\s&|]+)$/.test(s.trim());
  })) throw new Error('適用条件が不正です');
}

function ConstructionKnowhow_duplicate(rows, entry, includeInactive) {
  return rows.find(function (r) {
    return (includeInactive || r.status === '有効') && String(r.title).trim() === String(entry.title).trim() && String(r.category).trim() === String(entry.category).trim();
  });
}

function ConstructionKnowhow_write_(sh, rowNumber, entry) {
  const values = _CK_FIELDS.map(function (key) {
    const value = entry[key] == null ? '' : entry[key];
    // シート上でも本文は文字列として保持する（数式として実行しない）。
    return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
  });
  sh.getRange(rowNumber, 1, 1, _CK_FIELDS.length).setValues([values]);
}

function ConstructionKnowhow_locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function ConstructionKnowhow_add_(sh, rows, input) {
  const entry = Object.assign({ condition: '', steps: '', source: '', status: '有効' }, ConstructionKnowhow_entry_(input));
  if (Array.isArray(entry.steps)) entry.steps = entry.steps.join('\n');
  ConstructionKnowhow_validate_(entry);
  const duplicate = ConstructionKnowhow_duplicate(rows, entry, false);
  if (duplicate) return duplicate.id;
  const next = rows.reduce(function (max, r) {
    const match = String(r.id).match(/^KH-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  entry.id = 'KH-' + ('0000' + next).slice(-Math.max(4, String(next).length));
  entry.createdAt = entry.updatedAt = new Date();
  ConstructionKnowhow_write_(sh, sh.getLastRow() + 1, entry);
  rows.push(entry);
  return entry.id;
}

function ConstructionKnowhow_add(entry) {
  return ConstructionKnowhow_locked_(function () {
    const sh = ConstructionKnowhow_sheet_();
    return ConstructionKnowhow_add_(sh, ConstructionKnowhow_read_(sh), entry);
  });
}

function ConstructionKnowhow_update(id, patch) {
  return ConstructionKnowhow_locked_(function () {
    const sh = ConstructionKnowhow_sheet_();
    const rows = ConstructionKnowhow_read_(sh);
    const index = rows.findIndex(function (r) { return r.id === id; });
    if (index < 0) throw new Error('施工ノウハウが見つかりません: ' + id);
    const entry = Object.assign({}, rows[index], ConstructionKnowhow_entry_(patch), { id: id, createdAt: rows[index].createdAt, updatedAt: new Date() });
    if (Array.isArray(entry.steps)) entry.steps = entry.steps.join('\n');
    ConstructionKnowhow_validate_(entry);
    if (entry.status === '有効' && ConstructionKnowhow_duplicate(rows.filter(function (r) { return r.id !== id; }), entry, false)) throw new Error('同一タイトル・分類の有効行が存在します');
    ConstructionKnowhow_write_(sh, index + 2, entry);
    return id;
  });
}

function ConstructionKnowhow_setStatus(id, status) { return ConstructionKnowhow_update(id, { status: status }); }

function ConstructionKnowhow_seed() {
  return ConstructionKnowhow_locked_(function () {
    const sh = ConstructionKnowhow_sheet_();
    const rows = ConstructionKnowhow_read_(sh);
    const ids = [];
    ConstructionKnowhow_seedEntries().forEach(function (entry) {
      // 編集・廃止済みの初期行を復活させない。要確認行も二重投入しない。
      if (!ConstructionKnowhow_duplicate(rows, entry, true)) ids.push(ConstructionKnowhow_add_(sh, rows, entry));
    });
    return { added: ids.length, ids: ids };
  });
}

/** 初期資料は出典を保持し、以後はシートを正本とする。 */
function ConstructionKnowhow_seedEntries() {
  const data = [
    ['床タイル', '標準手順', '設営', 'kw:床タイル|フロアタイル|タイル', '床タイルの設営', '床タイルは解放面（通路側）手前のエッジ・コーナーから“への字”に組み、短い辺から1列ずつ作成して連結する。タイルは小間よりやや小さく仕上がる設計のため、への字から組まないと完成後にずれ、最悪組み直しになる。床固定は弱粘着両面テープのみ、接着剤・ボンド・床着色禁止。カットはしない（余りは隙間として残す）。', 'タイル向き確認\n解放面手前のコーナー設置\nへの字にエッジ設置\n短辺から1列ずつタイル連結\n最終チェック（浮き・段差・ずれ）', '設営作業手順(作業手順).pdf 1A5M5yGKdyxbrrxMrnEgtKc4IFZaHuYnh 2026-04-11／使い方テンプレ_README 14U8rAOPeEpRJ2OnZ4AKQyCDV9IaDyJwg／Growi p0215'],
    ['床タイル', '標準手順', '撤去', 'kw:床タイル|フロアタイル|タイル', '床タイルの撤去', 'タイルを剥がし段ボール・展示台にそのまま収納（箱の中でばらけないためテープ固定不要）。エッジ・コーナーも合わせて収納。', 'タイルを剥がす\n段ボール・展示台にそのまま収納（テープ固定不要）\nエッジ・コーナーも合わせて収納', '撤去作業手順(作業手順).pdf 17qMFO2iTGGsXxGJQ-RViSR64GoTQ6WVK'],
    ['施工順', '絶対ルール', '設営', '', '設営の施工順', '施工順は 床タイル → LED UP・DIYパネル → トラス → 装飾 → 照明・モニター → 清掃。', '', '設営作業手順 PDF'],
    ['パース・図面', '体裁', '共通', '', '最新パース・図面の貼付', 'パース図・平面図・立面図は必ず手順書に組み込む（口頭説明で済ませない）。小さくなる場合は図版専用スライドにし本文は“p○参照”で誘導。トラス図は確定仕様版を使い過去案件の図を流用しない。資料が食い違う時の優先順位は 確定仕様書/ハンドオフメモ > アイテムリスト > 会場図面・パース > 担当者確認 > 過去案件（値の流用禁止）。最新版かはプロデューサーに確認したものを使う。', '', '施工手順書_作成基準_v3.md 1x7dGvkr6HOUfv2x8pAF_YQCRUCzFoKIR §2-4 §5 §6／Growi p0215'],
    ['アンカー', '標準手順', '設営', 'kw:アンカー', 'アンカーの打設', '準備: 保護ゴーグル・手袋・ヘルメット／ハンマードリル＋アンカー径に合うSDSビット（M10 なら φ10.5mm）／ビットの規定深さ位置に養生テープでマーキング／掃除機・ブロアーを穿孔位置近くに／アンカー本数と位置を立会者と確認（申請済み位置以外に穴をあけない）／カーペットに養生シート／墨出しと図面を照合／周辺ブースへ周知／立会者承認。', '垂直にセット\n集塵ノズル近接\n低速で規定深さまで穿孔\n垂直に引き抜き\n粉塵吸引\n孔内吸引\nボルト挿入\nハンマーで頭を面一まで打込み\n軽く引いて固着確認\nマーキング\n清掃\n最後に垂直・頭高さ・立会者承認・全体写真を当日チャネルへ', 'アンカー打設手順_1行1手順.xlsx 1njpr4OiIBTLJJiwz5ruwxHSkoS3Mll7F 2026-07-22／Growi p0363 §6'],
    ['アンカー', '標準手順', '撤去', 'kw:アンカー', 'アンカーの撤去', 'アンカーはディスクグラインダで床面と水平に切断。切断者は専任、周囲の可燃物を排除し不燃シート、消火器を手元に配置、保護ゴーグル着用。埋込み部は無理に引き抜かない。全数を立会撮影。', '専任の切断者を配置\n周囲の可燃物を排除し不燃シート・消火器を配置\n保護ゴーグル着用\nディスクグラインダで床面と水平に切断\n埋込み部は無理に引き抜かない\n全数を立会撮影', 'MAK v7 1hHg09XwxupoJ6zJhmc1NcG-GEOLOp5AD／W2 pptx v1 19oicK5nCFgq_iN_GKugWhNskR7bY-dub'],
    ['アンカー', '注意', '共通', 'kw:アンカー', 'アンカーの会場規定確認', '穴深さ・ドリル貸与の有無・違反金・撤去時の処理（切断か引抜きか）は会場規定で異なる（例: パシフィコ/幕張RXは 50mm以内・会場貸与ドリルのみ・違反1本20,000円・切断未処理2,000円/本）。案件の会場規定で確認し、未確認なら要確認に出す。位置・本数の変更は床面工事申請の再提出が必要（W2 は施工2日目午前が期限）。', '', 'MAK v7／MED／【10/16】W2様 森下さん打合せ 1RgZuRAn5df966TXzr-DZygyfDjhhoMgZsPhlgRMvD3A', '要確認'],
    ['トラス', '絶対ルール', '共通', 'kw:トラス', 'トラス吊りモニターの支持条件', 'モニターをトラスに吊るす場合、4本足でロの字ができていること。ロの字にならない場合は必ずアンカー打設を申請。', '', '261021WTW W2 レイアウト 1sTFShw2IA0bHUxN-wDxFKiHSoG-wnqFdkH7zXaI3qTg'],
    ['トラス', '標準手順', '設営', 'kw:トラス', 'トラスの組立', '天井部トラスを床で仮置きして部品・寸法確認→足を組む→接続は2個を2箇所ずつ（計4個）→床を先に敷きトラスはその上に立てる→斜め・不安定がないか確認。ボルトは回しすぎない（ナット山でボルト山を削るとサンダー切断以外に対処不能）。脚立はハーネス、天板に乗らない・座らない。解体は4名（脚立2・下2）。重りはゴミ袋3重に水4Lで口を縛る。', '天井部トラスを床で仮置きして部品・寸法確認\n足を組む\n接続は2個を2箇所ずつ（計4個）\n床を先に敷きトラスはその上に立てる\n斜め・不安定がないか確認', '黒トラス(組立).pdf 1VLNNm1YkXnN4uT7mJdtylcGjKw1OnzhF／設営作業手順 PDF'],
    ['LEDUP', '絶対ルール', '共通', 'kw:LEDUP|LED UP', 'LEDUPの取扱い', 'LEDUP の金具は締めすぎ厳禁（過去2度破損）。ぐらつきが止まった時点で止める。H3000 と H2700 のパーツを間違えやすいので事前に高さを伝える。布は裏→表の順。LEDUP 部材は他ボックスに混ぜず、撤去時は番号を揃えてケースへ。', '', '作成基準 v3 付録A-2／設営作業手順(全体).pdf 1MYny-ZJ0aqhEh-TSMFEt80FIrbnzL54K'],
    ['養生', '絶対ルール', '共通', '', '固定部材と床の養生', '展示台パネルに両面テープで貼る場合は先に養生テープを貼りその上に両面テープ。スチレンボードはベルクロ禁止・テグス必須。カーペット・床は弱粘着両面テープのみ。', '', 'W2 Doc v2 1WCC_OKJCFn3nAkMRT0sYUoj9ZxdI1ma9XrclLZh-xLs／設営作業手順 PDF'],
    ['白布黒布', '標準手順', '設営', 'kw:白布|黒布|ターポリン', '白布・黒布・ターポリンの取扱い', '白布は汚れのない白手袋で LEDUP 白布を裏→表。黒布（隣接目隠し）は4隅1個＋50cm毎に安全ピン。ターポリンは上辺→下辺→両側の順でリピートタイ固定、折らずに芯棒に巻く。', '汚れのない白手袋で LEDUP 白布を裏→表\n黒布は4隅1個＋50cm毎に安全ピン\nターポリンは上辺→下辺→両側の順でリピートタイ固定\nターポリンは折らずに芯棒に巻く', '設営/撤去作業手順 PDF'],
    ['撤収', '絶対ルール', '撤去', '', '撤去部材の集約と梱包', '撤去はエリアごとにまとめて置く→数量確認→梱包。外した部材をその場で個別に梱包しない。', '', 'W2 pptx v1 p.30'],
    ['体裁', '絶対ルール', '共通', '', '発行名義と本文の体裁', '発行名義は株式会社オージャスト（Re:ブース表記を使わない）。社内連絡・送金・個人宛メンション・社内メモの日付を手順書本文に書かない。撤去品は再利用前提で“廃棄・処分・安い”の語を使わない。未確定は要確認ページに集約。', '', '作成基準 v3 §2〜§7／2026-10-15 C0034 生成物レビュー'],
    ['電気', '注意', '共通', '', '電気配線の保護', '一次側（分電盤）までは会場工事。配線は PVC プロテクターで保護し通路横断部はつまずき防止。トラス内コードはマジックテープ式で結束（テープ巻き禁止）。', '', '電気配線.pdf 1CxmFZ_MUFK0J4xCiLe7Bzu20CVULBJpp']
  ];
  return data.map(function (r) {
    return { category: r[0], type: r[1], phase: r[2], condition: r[3], title: r[4], body: r[5], steps: r[6], source: r[7], status: r[8] || '有効' };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ConstructionKnowhow_matches: ConstructionKnowhow_matches, ConstructionKnowhow_caseText: ConstructionKnowhow_caseText, ConstructionKnowhow_filter: ConstructionKnowhow_filter, ConstructionKnowhow_duplicate: ConstructionKnowhow_duplicate, ConstructionKnowhow_seedEntries: ConstructionKnowhow_seedEntries };
}
