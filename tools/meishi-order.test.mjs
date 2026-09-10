// node --test tools/meishi-order.test.mjs
// ネットワーク不要。HTML はテスト内の小さなフィクスチャ。
import test from "node:test";
import assert from "node:assert/strict";

import {
  attrValue,
  decodeEntities,
  normalizeSpace,
  stripTags,
  parseCardRows,
  extractJsonVars,
  designItemMap,
  collectItemValues,
  pickItemValues,
  findBackDesign,
  matchTarget,
  serializeForm,
  shipMethodFor,
  parseNewAddr,
  parseQuantityOptions,
  parseOrderRows,
  parseTableRows,
  rowsToObjects,
  parseArgs,
  parseEnv,
  findChromium,
  splitSetCookie,
  extractCsrfMeta,
} from "./meishi-order.mjs";

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const CARD_LIST_HTML = `<!doctype html><html><head>
<meta name="csrf-token" content="csrf-abcdef">
</head><body>
<table id="businesscard_table">
  <tr class="businesscard_row" data-businesscard_id="289720" data-size="一般（91mm x 55mm)">
    <td>営業</td>
    <td>Sawayama.T</td>
    <td>澤山 貴俊</td>
    <td>289720</td>
    <td class="application_col"><a href="/cloudb2/businesscard/information/289720/application">申請</a></td>
    <td>編集 コピー 削除</td>
    <td>2026-08-25 21:42</td>
    <td>注文差分</td>
  </tr>
  <tr class="businesscard_row" data-businesscard_id="291001" data-size="一般（91mm x 55mm)">
    <td>クリエイティブ</td>
    <td>Sato.H</td>
    <td>佐藤 花子</td>
    <td>291001</td>
    <td class="application_col"></td>
    <td>編集 コピー 削除</td>
    <td></td>
    <td></td>
  </tr>
  <tr class="header_row"><td>グループ</td><td>社員ID</td></tr>
</table>
<select name="application_single_quantity">
  <option value="100">100枚</option>
  <option value="200">200枚</option>
</select>
<div class="pager"><a href="/cloudb2/businesscard/information?display_count=300&amp;p=2">次</a></div>
</body></html>`;

const EDIT_HTML = `<!doctype html><html><head></head><body>
<script>
const design_items_front = [{"design_id":1,"items":[{"item_id":6045,"display_name":"役職"},{"item_id":6001,"display_name":"姓名"},{"item_id":6002,"display_name":"URL"},{"item_id":6100,"display_name":"mobile"}]}];
const design_items_back = [{"design_id":2,"items":[{"item_id":7001,"display_name":"ロゴ"}]}];
const init_param = {"design_id":2,"design_name":"\\u88cf\\u9762new202405","frontable":{"list":[{"type":"free","item_id":6045,"variable_id":null,"value":"\\u4f01\\u696d\\u5c55\\u793a\\u30b3\\u30fc\\u30c7\\u30a3\\u30cd\\u30fc\\u30c8\\u4e8b\\u696d\\u90e8\\u3000\\u90e8\\u9577"},{"type":"free","item_id":6001,"value":"\\u6fa4\\u5c71 \\u8cb4\\u4fca"},{"type":"free","item_id":6002,"value":"https://orgiast.jp/"},{"type":"free","item_id":6100,"value":"090-0000-0000"}]}};
</script>
</body></html>`;

// 実際の /businesscard/order の行構造(2026-09-10 実測): 申請日時はスラッシュ区切り。
const ORDER_HTML = `<!doctype html><html><body>
<table>
  <tr data-group_id="4345">
    <td><input type="checkbox" name="ids[]" value="328596"></td>
    <td><a href="#" class="view_thumbnail" data-businesscard_id="289720"><img src="x.png"></a></td>
    <td>営業</td>
    <td>澤山 貴俊</td>
    <td>289720</td>
    <td>100</td>
    <td>2026/09/09 15:39</td>
    <td></td>
    <td>申請を却下</td>
  </tr>
  <tr data-group_id="13">
    <td><input type="checkbox" name="ids[]" value="55502"></td>
    <td><a href="#" class="view_thumbnail" data-businesscard_id="291001"><img src="y.png"></a></td>
    <td>クリエイティブ</td>
    <td>佐藤 花子</td>
    <td>291001</td>
    <td>200</td>
    <td>2026-09-10 09:00</td>
    <td></td>
    <td>申請を却下</td>
  </tr>
</table>
<select name="billing_address_id"><option value="461">オージャスト経理</option><option value="595">基本請求先</option></select>
</body></html>`;

const HISTORY_HTML = `<!doctype html><html><body>
<table>
  <thead><tr><th>申請日時</th><th>社員ID</th><th>名前</th><th>名刺ID</th><th>枚数</th><th>状態</th><th>承認中グループ</th><th>備考</th></tr></thead>
  <tbody>
    <tr><td>2026-09-09 15:39</td><td>Sawayama.T</td><td>澤山 貴俊</td><td>289720</td><td>100</td><td>申請中</td><td></td><td></td></tr>
    <tr><td>2026-08-01 10:00</td><td>Sato.H</td><td>佐藤 花子</td><td>291001</td><td>200</td><td>承認済</td><td>営業</td><td>急ぎ</td></tr>
  </tbody>
</table>
</body></html>`;

// ---------------------------------------------------------------------------
// 文字列ユーティリティ
// ---------------------------------------------------------------------------

test("normalizeSpace は全角スペースも畳む", () => {
  assert.equal(normalizeSpace("  澤山　貴俊  "), "澤山 貴俊");
  assert.equal(normalizeSpace(null), "");
});

test("stripTags はタグを空白に置き換えて語を連結しない", () => {
  assert.equal(stripTags("<td>営業</td><td>Sawayama.T</td>"), "営業 Sawayama.T");
  assert.equal(stripTags("<b>澤山</b>&nbsp;貴俊"), "澤山 貴俊");
});

test("decodeEntities は主要な実体参照を戻す", () => {
  assert.equal(decodeEntities("a&amp;b&nbsp;c&lt;d&gt;"), "a&b c<d>");
  assert.equal(decodeEntities("it&#039;s"), "it's");
});

test("attrValue は属性名の直前の空白を要求する (data-name= を誤マッチしない)", () => {
  const tag = '<input data-name="dummy" name="_token" value="abc">';
  assert.equal(attrValue(tag, "name"), "_token");
  assert.equal(attrValue(tag, "data-name"), "dummy");
  assert.equal(attrValue(tag, "value"), "abc");
  assert.equal(attrValue(tag, "missing"), null);
  assert.equal(attrValue("<td data-businesscard_id='9'>", "data-businesscard_id"), "9");
});

// ---------------------------------------------------------------------------
// 名刺リスト
// ---------------------------------------------------------------------------

test("parseCardRows は businesscard_row だけを行にする", () => {
  const rows = parseCardRows(CARD_LIST_HTML);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.businesscardId),
    ["289720", "291001"]
  );
});

test("parseCardRows は グループ/社員ID/名前/サイズ/前回注文日時 を取り出す", () => {
  const [a] = parseCardRows(CARD_LIST_HTML);
  assert.equal(a.group, "営業");
  assert.equal(a.employeeId, "Sawayama.T");
  assert.equal(a.name, "澤山 貴俊");
  assert.equal(a.size, "一般（91mm x 55mm)");
  assert.equal(a.lastOrderAt, "2026-08-25 21:42");
  assert.equal(a.hasDiff, true);
});

test("parseCardRows は application_col の有無で申請済みを判定する", () => {
  const [a, b] = parseCardRows(CARD_LIST_HTML);
  assert.equal(a.hasApplicationLink, true);
  assert.equal(b.hasApplicationLink, false);
  assert.equal(b.lastOrderAt, "");
  assert.equal(b.hasDiff, false);
});

test("parseQuantityOptions は枚数の選択肢を取る", () => {
  assert.deepEqual(parseQuantityOptions(CARD_LIST_HTML), [
    { value: "100", label: "100枚" },
    { value: "200", label: "200枚" },
  ]);
  assert.deepEqual(parseQuantityOptions("<html></html>"), []);
});

test("extractCsrfMeta は meta の content を返す", () => {
  assert.equal(extractCsrfMeta(CARD_LIST_HTML), "csrf-abcdef");
  assert.equal(extractCsrfMeta("<html></html>"), null);
});

// ---------------------------------------------------------------------------
// 編集ページ(役職などの項目)
// ---------------------------------------------------------------------------

test("extractJsonVars は 1 行 JSON 定義を JSON.parse する (\\uXXXX も戻る)", () => {
  const vars = extractJsonVars(EDIT_HTML);
  assert.ok(Array.isArray(vars.design_items_front));
  assert.ok(Array.isArray(vars.design_items_back));
  assert.equal(vars.init_param.design_name, "裏面new202405");
  assert.equal(typeof vars.init_param.frontable, "object");
});

test("extractJsonVars は JSON でない代入を無視する", () => {
  const vars = extractJsonVars("<script>\nconst x = someFunc(1);\nlet y = [1,2];\n</script>");
  assert.equal("x" in vars, false);
  assert.deepEqual(vars.y, [1, 2]);
});

test("designItemMap は item_id -> display_name を畳む", () => {
  const vars = extractJsonVars(EDIT_HTML);
  const map = designItemMap(vars.design_items_front);
  assert.equal(map.get("6045"), "役職");
  assert.equal(map.get("6100"), "mobile");
});

test("collectItemValues はネストした {item_id,value} を全部集める", () => {
  const vars = extractJsonVars(EDIT_HTML);
  const items = collectItemValues(vars.init_param);
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((i) => i.item_id).sort(),
    [6001, 6002, 6045, 6100]
  );
});

test("pickItemValues は display_name で値を引けるようにする", () => {
  const vars = extractJsonVars(EDIT_HTML);
  const values = pickItemValues(vars.init_param, vars.design_items_front);
  assert.equal(values["役職"], "企業展示コーディネート事業部　部長");
  assert.equal(values["姓名"], "澤山 貴俊");
  assert.equal(values["URL"], "https://orgiast.jp/");
  assert.equal(values["mobile"], "090-0000-0000");
});

test("pickItemValues は未知の item_id を item_<id> で残す", () => {
  const values = pickItemValues({ a: { item_id: 999, value: "v" } }, []);
  assert.equal(values["item_999"], "v");
});

test("findBackDesign は裏面デザインを拾う", () => {
  const vars = extractJsonVars(EDIT_HTML);
  const back = findBackDesign(vars.init_param);
  assert.ok(back);
  assert.equal(back.designName, "裏面new202405");
  assert.equal(back.designId, "2");
});

test("findBackDesign は裏面が無ければ null", () => {
  assert.equal(findBackDesign({ a: { design_id: 1, design_name: "表面" } }), null);
  assert.equal(findBackDesign(null), null);
});

// ---------------------------------------------------------------------------
// 対象の特定
// ---------------------------------------------------------------------------

test("matchTarget は名前の空白を無視して部分一致する", () => {
  const rows = parseCardRows(CARD_LIST_HTML);
  assert.equal(matchTarget(rows, "澤山").length, 1);
  assert.equal(matchTarget(rows, "澤山貴俊").length, 1);
  assert.equal(matchTarget(rows, "  澤山  ").length, 1);
});

test("matchTarget は社員IDを大小無視・名刺IDは部分一致で見る", () => {
  const rows = parseCardRows(CARD_LIST_HTML);
  assert.equal(matchTarget(rows, "sawayama.t").length, 1);
  assert.equal(matchTarget(rows, "SAWAYAMA").length, 1);
  assert.equal(matchTarget(rows, "2897").length, 1);
  assert.equal(matchTarget(rows, "291001").length, 1);
});

test("matchTarget は複数一致・0件をそのまま返す", () => {
  const rows = parseCardRows(CARD_LIST_HTML);
  assert.equal(matchTarget(rows, "佐").length, 1);
  assert.equal(matchTarget(rows, "存在しない").length, 0);
  assert.equal(matchTarget(rows, "").length, 0);
});

// ---------------------------------------------------------------------------
// 送信フォーム
// ---------------------------------------------------------------------------

test("serializeForm は配列を key[] に展開し、空文字も落とさない", () => {
  assert.equal(
    serializeForm({ businesscard_id_list: ["289720"], quantity: 100, note: "" }),
    "businesscard_id_list%5B%5D=289720&quantity=100&note="
  );
});

test("serializeForm は key が既に [] で終わっていれば二重に付けない", () => {
  assert.equal(serializeForm({ "ids[]": ["1", "2"] }), "ids%5B%5D=1&ids%5B%5D=2");
});

test("serializeForm は日本語と記号を URL エンコードする", () => {
  assert.equal(serializeForm({ note: "至急 & 丁寧に" }), "note=%E8%87%B3%E6%80%A5%20%26%20%E4%B8%81%E5%AF%A7%E3%81%AB");
});

test("shipMethodFor は 500 枚以上で宅配便に切り替える", () => {
  assert.equal(shipMethodFor(100, "メール便"), "メール便");
  assert.equal(shipMethodFor(499, "メール便"), "メール便");
  assert.equal(shipMethodFor(500, "メール便"), "宅配便");
  assert.equal(shipMethodFor(1000, "ゆうパケット"), "宅配便");
  assert.equal(shipMethodFor(500, "宅配便"), "宅配便");
  assert.equal(shipMethodFor("500", undefined), "宅配便");
  assert.equal(shipMethodFor(null, "メール便"), "メール便");
});

// ---------------------------------------------------------------------------
// 申請中一覧 / テーブル
// ---------------------------------------------------------------------------

test("parseOrderRows は申請ID・名刺ID・枚数・申請日時を取る", () => {
  const rows = parseOrderRows(ORDER_HTML);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].groupId, "4345");
  assert.equal(rows[0].applicationId, "328596");
  assert.equal(rows[0].businesscardId, "289720");
  assert.equal(rows[0].quantity, 100);
  // 申請日時は実ページではスラッシュ区切り
  assert.equal(rows[0].appliedAt, "2026/09/09 15:39");
  assert.equal(rows[1].businesscardId, "291001");
  assert.equal(rows[1].quantity, 200);
  // ハイフン区切りでも読める
  assert.equal(rows[1].appliedAt, "2026-09-10 09:00");
});

test("parseOrderRows は名刺IDのセルを枚数と取り違えない", () => {
  const rows = parseOrderRows(ORDER_HTML);
  assert.notEqual(rows[0].quantity, 289720);
});

test("parseOrderRows は関係ない行を無視する", () => {
  assert.equal(parseOrderRows("<table><tr><td>見出し</td></tr></table>").length, 0);
});

test("parseTableRows は thead の th をヘッダに、td を行にする", () => {
  const t = parseTableRows(HISTORY_HTML);
  assert.deepEqual(t.headers, ["申請日時", "社員ID", "名前", "名刺ID", "枚数", "状態", "承認中グループ", "備考"]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][5], "申請中");
});

test("rowsToObjects はヘッダ名で引けるようにする", () => {
  const objs = rowsToObjects(parseTableRows(HISTORY_HTML));
  assert.equal(objs[0]["社員ID"], "Sawayama.T");
  assert.equal(objs[1]["状態"], "承認済");
  assert.equal(objs[0].cells.length, 8);
});

// ---------------------------------------------------------------------------
// CLI 引数 / env / 環境
// ---------------------------------------------------------------------------

test("parseArgs はコマンドと既定値を返す", () => {
  const a = parseArgs(["order", "澤山"]);
  assert.equal(a.command, "order");
  assert.equal(a.query, "澤山");
  assert.equal(a.yes, false);
  assert.equal(a.headful, false);
  assert.equal(a.qty, 100);
  assert.equal(a.paper, "マットポスト 180kg");
  assert.equal(a.corner, "なし");
  assert.equal(a.pack, ""); // 空=配送方法から決める(メール便=トレイ, 宅配便=紙箱)
  assert.equal(a.ship, "メール便");
  assert.equal(a.days, 0);
});

test("parseArgs はオプションを読む", () => {
  const a = parseArgs(["order", "澤山", "--qty", "200", "--to", "本社", "--yes", "--headful", "--days", "1", "--ship", "宅配便"]);
  assert.equal(a.qty, 200);
  assert.equal(a.to, "本社");
  assert.equal(a.yes, true);
  assert.equal(a.headful, true);
  assert.equal(a.days, 1);
  assert.equal(a.ship, "宅配便");
  assert.equal(a.query, "澤山");
});

test("parseArgs は --note / --json / --help を読む", () => {
  const a = parseArgs(["apply", "澤山", "--note", "至急 お願いします", "--json"]);
  assert.equal(a.note, "至急 お願いします");
  assert.equal(a.json, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs は数値でない --qty を無視して既定を保つ", () => {
  assert.equal(parseArgs(["apply", "x", "--qty", "abc"]).qty, 100);
});

test("parseEnv は KEY=VALUE を読み、引用符を外し、コメントを無視する", () => {
  const env = parseEnv('# コメント\nMAHITO_ID=orgiast\nMAHITO_PASSWORD="p@ss=word"\n\nMAHITO_BILLING_ID=595\n');
  assert.equal(env.MAHITO_ID, "orgiast");
  assert.equal(env.MAHITO_PASSWORD, "p@ss=word");
  assert.equal(env.MAHITO_BILLING_ID, "595");
  assert.equal(Object.keys(env).length, 3);
});

test("findChromium は chrome-win64 → chrome-win の順に探す", () => {
  const readdir = () => [
    { name: "chromium-1228", isDirectory: () => true },
    { name: "firefox-1", isDirectory: () => true },
  ];
  const exists = (p) => p.endsWith("chrome-win64/chrome.exe") || p.endsWith("chrome-win64\\chrome.exe");
  const found = findChromium("C:/browsers", readdir, exists);
  assert.ok(found && found.includes("chromium-1228"));

  // chrome-win64 が無ければ chrome-win に落ちる
  const exists2 = (p) => p.includes("chrome-win") && !p.includes("chrome-win64") && p.endsWith("chrome.exe");
  assert.ok(findChromium("C:/browsers", readdir, exists2).includes("chrome-win"));
});

test("findChromium は存在しないディレクトリで null", () => {
  assert.equal(findChromium("C:/none", () => { throw new Error("ENOENT"); }, () => true), null);
  assert.equal(findChromium(null), null);
});

test("findChromium は新しい版の chromium を優先する", () => {
  const readdir = () => [
    { name: "chromium-1100", isDirectory: () => true },
    { name: "chromium-1228", isDirectory: () => true },
  ];
  const found = findChromium("C:/browsers", readdir, () => true);
  assert.ok(found.includes("chromium-1228"));
});

test("splitSetCookie は getSetCookie が無くても Expires のカンマで壊れない", () => {
  const fake = {
    getSetCookie: undefined,
    get: () => "laravel_session=abc; Path=/; HttpOnly, XSRF-TOKEN=def; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
  };
  const parts = splitSetCookie(fake);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith("laravel_session=abc"));
  assert.ok(parts[1].startsWith("XSRF-TOKEN=def"));
});

test("splitSetCookie は getSetCookie があればそれを使う", () => {
  const fake = { getSetCookie: () => ["a=1", "b=2"], get: () => null };
  assert.deepEqual(splitSetCookie(fake), ["a=1", "b=2"]);
});

test("parseNewAddr は 6 項目を配送先オブジェクトにし、郵便番号と電話の記号を除く", () => {
  const r = parseNewAddr("株式会社オージャスト|澤山 貴俊|560-0003|6-15-22|407|080-6996-5329");
  assert.equal(r.ok, true);
  assert.equal(r.zip1, "560");
  assert.equal(r.zip2, "0003");
  assert.equal(r.tel, "08069965329");
  assert.equal(r.building, "407");
});

test("parseNewAddr は建物名が空でも通り、項目不足・郵便番号桁違いは拒否する", () => {
  assert.equal(parseNewAddr("A|B|5600003|1-2-3||0612345678").ok, true);
  assert.equal(parseNewAddr("A|B|560-0003|1-2-3|0612345678").ok, false);
  assert.equal(parseNewAddr("A|B|560-003|1-2-3||0612345678").ok, false);
  assert.equal(parseNewAddr("A|B|560-0003|1-2-3||06123").ok, false);
});

test("parseArgs は --to new --new-addr を受ける", () => {
  const a = parseArgs(["order", "澤山", "--to", "new", "--new-addr", "A|B|560-0003|1||0612345678"]);
  assert.equal(a.to, "new");
  assert.equal(a.newAddr, "A|B|560-0003|1||0612345678");
});
