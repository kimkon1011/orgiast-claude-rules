import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const upsert = fs.readFileSync(
  new URL("../gas/fleet-status-sheet/UpsertLogic.gs", import.meta.url),
  "utf8",
);
const logic = fs.readFileSync(
  new URL("../gas/fleet-status-sheet/CloudLedgerLogic.gs", import.meta.url),
  "utf8",
);
const io = fs.readFileSync(
  new URL("../gas/fleet-status-sheet/CloudLedger.gs", import.meta.url),
  "utf8",
);
const context = {};
vm.createContext(context);
vm.runInContext(`${upsert}\n${logic}`.replace(/\bconst\s+/g, "var "), context);
const project = [...context.CLOUD_PROJECT_HEADERS_];
const contracts = [...context.CLOUD_CONTRACT_HEADERS_];
const logins = [...context.CLOUD_LOGIN_HEADERS_];
const row = (headers, values = {}) =>
  headers.map((header) => values[header] ?? "");

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test("project allowlist survives 200 shuffled column orders", () => {
  const forbidden = [
    "用途・説明",
    "Supabaseプロジェクト",
    "GASスクリプトID",
    "関連スプレッドシート",
    "状態",
    "備考",
  ];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const headers = shuffle(project);
    const existing = row(headers, {
      GitHubリポジトリ: "kim/app",
      "用途・説明": "人の値",
      状態: "稼働中",
    });
    const plan = context.cloudPlanProjectUpsert(headers, [existing], {
      projects: [
        {
          project: "app",
          repo: "kim/app",
          ghAccount: "kim",
          visibility: "private",
          prodUrl: "url",
          devPc: "PC-A",
          updatedAt: "now",
          purpose: "bad",
          status: "bad",
        },
      ],
    });
    const written = plan.updates.map(
      (update) => headers[update.columnIndex - 1],
    );
    for (const name of forbidden)
      assert(!written.includes(name), `${name} was written`);
    assert.equal(existing[headers.indexOf("用途・説明")], "人の値");
  }
});

test("fresh machine values replace existing project snapshot", () => {
  const existing = row(project, {
    GitHubリポジトリ: "kim/app",
    最終コミット: "2026-01-01 old",
    "更新日時(JST)": "2026-01-01 00:00",
    本番URL: "old.example",
    可視性: "private",
  });
  const plan = context.cloudPlanProjectUpsert(project, [existing], {
    projects: [
      {
        repo: "kim/app",
        lastCommit: "2026-08-28 new",
        updatedAt: "2026-08-28 10:00",
        prodUrl: "new.example",
        visibility: "public",
      },
    ],
  });
  const values = Object.fromEntries(
    plan.updates.map((update) => [
      project[update.columnIndex - 1],
      update.value,
    ]),
  );
  assert.equal(values["最終コミット"], "2026-08-28 new");
  assert.equal(values["更新日時(JST)"], "2026-08-28 10:00");
  assert.equal(values["本番URL"], "new.example");
  assert.equal(values["可視性"], "public");
});

test("project empty or unavailable values never clear cells and labels merge", () => {
  const existing = row(project, {
    GitHubリポジトリ: "kim/app",
    本番URL: "KEEP",
    開発PC: "PC-A",
  });
  const plan = context.cloudPlanProjectUpsert(project, [existing], {
    projects: [{ repo: "kim/app", prodUrl: "", devPc: "PC-B" }],
  });
  assert(
    !plan.updates.some(
      (update) => update.columnIndex === project.indexOf("本番URL") + 1,
    ),
  );
  assert.equal(
    plan.updates.find(
      (update) => update.columnIndex === project.indexOf("開発PC") + 1,
    ).value,
    "PC-A, PC-B",
  );
  assert.equal(context.cloudMergeLabels("PC-A, PC-B", "PC-A"), "PC-A, PC-B");
});

test("contract force controls nonempty overwrite and never writes the card column", () => {
  const existing = row(contracts, {
    サービス: "Vercel",
    "アカウント(ログインID)": "kim",
    プラン: "KEEP",
    "支払い元カード(下4桁)": "1234",
  });
  const normal = context.cloudPlanContractUpsert(contracts, [existing], {
    service: "Vercel",
    account: "kim",
    plan: "NEW",
    card: "9999",
  });
  assert.equal(normal.updates.length, 0);
  const forced = context.cloudPlanContractUpsert(contracts, [existing], {
    force: true,
    service: "Vercel",
    account: "kim",
    plan: "NEW",
    card: "9999",
  });
  assert.equal(forced.updates.length, 1);
  assert.equal(contracts[forced.updates[0].columnIndex - 1], "プラン");
  assert(
    !forced.updates.some(
      (update) => contracts[update.columnIndex - 1] === "支払い元カード(下4桁)",
    ),
  );
});

test("contract writes the four freee columns but never the card column across 200 column orders", () => {
  const expected = ["月額(税込)", "通貨", "支払い元(名義)", "請求サイクル"];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const headers = shuffle(contracts);
    const existing = row(headers, {
      サービス: "Groq",
      "アカウント(ログインID)": "",
      "支払い元カード(下4桁)": "1234",
    });
    const plan = context.cloudPlanContractUpsert(headers, [existing], {
      service: "Groq",
      account: "",
      monthlyAmount: 9800,
      currency: "JPY",
      payerName: "金立替／アメリカン・エキスプレス",
      billingCycle: "月次",
      card: "9999",
    });
    const written = plan.updates.map((update) => headers[update.columnIndex - 1]);
    assert.deepEqual([...written].sort(), [...expected].sort());
    assert(!written.includes("支払い元カード(下4桁)"));
  }
});

test("contract protects nonempty freee cells without force", () => {
  const existing = row(contracts, {
    サービス: "Groq",
    "月額(税込)": 100,
    通貨: "USD",
    "支払い元(名義)": "人の値",
    請求サイクル: "年次",
  });
  const plan = context.cloudPlanContractUpsert(contracts, [existing], {
    service: "Groq",
    monthlyAmount: 200,
    currency: "JPY",
    payerName: "機械の値",
    billingCycle: "月次",
  });
  assert.equal(plan.updates.length, 0);
});

test("contract machine-owned columns refresh without force while human columns remain protected", () => {
  const existing = row(contracts, {
    サービス: "Groq",
    "アカウント(ログインID)": "dev@example.jp",
    "月額(税込)": 100,
    "支払い元(名義)": "人の値",
    最終確認日: "2026-08-28",
    自動検出: "旧状態",
    通貨: "KEEP",
  });
  const payload = {
    service: "Groq",
    account: "dev@example.jp",
    monthlyAmount: 200,
    payerName: "機械の値",
    checkedAt: "2026-08-30",
    detected: "検出済み",
  };
  const normal = context.cloudPlanContractUpsert(contracts, [existing], payload);
  assert.deepEqual(
    Object.fromEntries(normal.updates.map((update) => [contracts[update.columnIndex - 1], update.value])),
    { 最終確認日: "2026-08-30", 自動検出: "検出済み" },
  );
  assert(!normal.updates.some((update) => contracts[update.columnIndex - 1] === "通貨"));

  const forced = context.cloudPlanContractUpsert(contracts, [existing], { ...payload, force: true });
  const forcedValues = Object.fromEntries(
    forced.updates.map((update) => [contracts[update.columnIndex - 1], update.value]),
  );
  assert.equal(forcedValues["月額(税込)"], 200);
  assert.equal(forcedValues["支払い元(名義)"], "機械の値");
  assert.equal(forcedValues["最終確認日"], "2026-08-30");
  assert.equal(forcedValues["自動検出"], "検出済み");
  assert(!Object.hasOwn(forcedValues, "通貨"));
});

test("contract never writes the card column across 200 shuffled column orders", () => {
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const headers = shuffle(contracts);
    const existing = row(headers, { サービス: "Groq", "アカウント(ログインID)": "dev@example.jp" });
    const plan = context.cloudPlanContractUpsert(headers, [existing], {
      force: true,
      service: "Groq",
      account: "dev@example.jp",
      card: "9999",
      monthlyAmount: 200,
      payerName: "機械の値",
      checkedAt: "2026-08-30",
      detected: "検出済み",
    });
    assert(!plan.updates.some((update) => headers[update.columnIndex - 1] === "支払い元カード(下4桁)"));
  }
});

test("contract does not touch monthly amount for unavailable values", () => {
  for (const monthlyAmount of [undefined, null, ""]) {
    const existing = row(contracts, { サービス: "Groq" });
    const plan = context.cloudPlanContractUpsert(contracts, [existing], {
      service: "Groq",
      monthlyAmount,
    });
    assert(
      !plan.updates.some(
        (update) => contracts[update.columnIndex - 1] === "月額(税込)",
      ),
    );
  }
});

test("login replacement deletes only own label rows", () => {
  const rows = [
    row(logins, { "PC名/ホスト名": "A" }),
    row(logins, { "PC名/ホスト名": "B" }),
    row(logins, { "PC名/ホスト名": "A" }),
  ];
  const plan = context.cloudPlanLoginReplace(logins, rows, {
    label: "A",
    rows: [{ service: "GitHub", status: "ログイン済み" }],
  });
  assert.deepEqual([...plan.deleteRowNumbers], [2, 4]);
  assert.equal(plan.appendRows.length, 1);
  assert.equal(plan.appendRows[0][logins.indexOf("状態")], "ログイン済み");
});

test("describe responses expose keys and safe payer names but never card values", () => {
  const datasets = {
    プロジェクト所在地図: {
      headers: project,
      rows: [
        row(project, { GitHubリポジトリ: "kim/app", プロジェクト名: "app" }),
      ],
    },
    クラウド契約: {
      headers: contracts,
      rows: [
        row(contracts, {
          サービス: "Vercel",
          "アカウント(ログインID)": "kim",
          "支払い元カード(下4桁)": "9876",
          "支払い元(名義)": "SECRET NAME",
        }),
      ],
    },
    PCログイン: {
      headers: logins,
      rows: [
        row(logins, {
          "PC名/ホスト名": "PC",
          サービス: "GitHub",
          ログインアカウント: "kim",
        }),
      ],
    },
  };
  const fake = {
    ...context,
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => "id" }),
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => {
          const data = datasets[name];
          return {
            getLastColumn: () => data.headers.length,
            getLastRow: () => data.rows.length + 1,
            getRange: (sheetRow) => ({
              getDisplayValues: () =>
                sheetRow === 1 ? [data.headers] : data.rows,
            }),
          };
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
    },
  };
  vm.createContext(fake);
  vm.runInContext(io, fake);
  const ledgerSerialized = JSON.stringify(fake.describeCloudLedger());
  assert.match(ledgerSerialized, /kim\/app/);
  assert(!ledgerSerialized.includes("9876"));
  assert(!ledgerSerialized.includes("SECRET NAME"));

  const contractsResult = fake.describeCloudContracts();
  assert(contractsResult.columns.includes("支払い元(名義)"));
  const contractSerialized = JSON.stringify(contractsResult);
  assert(contractSerialized.includes("SECRET NAME"));
  assert(!contractSerialized.includes("9876"));
  assert(!contractsResult.columns.includes("支払い元カード(下4桁)"));
});

test("setup persists sheet ID before sharing and reports sharing and move failures", () => {
  const properties = new Map();
  const createdSheets = [];
  const setupContext = {
    CLOUD_PROJECT_HEADERS_: project,
    CLOUD_CONTRACT_HEADERS_: contracts,
    CLOUD_LOGIN_HEADERS_: logins,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) || "",
        setProperty: (key, value) => properties.set(key, value),
      }),
    },
    SpreadsheetApp: {
      create: () => {
        const book = makeBookStub(["シート1"], { empty: ["シート1"] });
        book.created = createdSheets;
        return book;
      },
    },
    DriveApp: {
      Access: { DOMAIN: "DOMAIN" },
      Permission: { EDIT: "EDIT" },
      getFileById: () => ({
        setSharing: () => {
          throw new Error("shared-drive restriction");
        },
        moveTo: () => {
          throw new Error("move denied");
        },
      }),
      getFolderById: () => ({}),
    },
  };
  properties.set("CLOUD_LEDGER_FOLDER_ID", "folder-id-1234567890");
  vm.createContext(setupContext);
  vm.runInContext(io, setupContext);
  const result = setupContext.setupCloudLedger();
  assert.equal(properties.get("CLOUD_LEDGER_SHEET_ID"), "sheet-id-1234567890");
  assert.deepEqual(createdSheets, [
    "プロジェクト所在地図",
    "クラウド契約",
    "PCログイン",
  ]);
  assert.match(result.sharing, /^失敗\(shared-drive restriction\)$/);
  assert.match(result.movedToFolder, /^失敗\(move denied\)$/);
});

test("command queue exposes all cloud ledger supervisor commands", () => {
  const source = fs.readFileSync(
    new URL("../gas/fleet-status-sheet/CommandQueue.gs", import.meta.url),
    "utf8",
  );
  for (const command of [
    "setupCloudLedger",
    "describeCloudLedger",
    "setCloudLedgerFolder",
  ]) {
    assert.match(source, new RegExp(`${command}:\\s*${command}`));
  }
});

test("distributed cloud CLIs use the symlink-safe entry helper", () => {
  for (const file of ["./cloud-inventory.mjs", "./project-locator.mjs"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import \{ isEntry \} from ["']\.\/is-entry\.mjs["']/);
    assert.match(source, /if \(isEntry\(import\.meta\.url\)\)/);
    assert(
      !source.includes(
        "path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)",
      ),
    );
  }
});

// 回帰テスト: GAS はファイルを**アルファベット順**に評価するので、CloudLedger.gs は
// CloudLedgerLogic.gs より先に走る。ヘッダ定数をトップレベルの var で束ねていたため
// undefined になり、setupCloudLedger が
// 「Cannot read properties of undefined (reading 'length')」で落ちた(2026-08-28 実測)。
// テスト側で Logic を先に読み込んでいたので、この壊れ方が緑のまま素通りしていた。
// **本番と同じ順序**で評価して固定する。
test("GAS のファイル評価順(CloudLedger.gs が先)でもタブ定義が解決できる", () => {
  const book = makeBookStub(["シート1"], { empty: ["シート1"] });
  const properties = {};
  const gas = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] ?? null,
        setProperty: (key, value) => {
          properties[key] = value;
        },
      }),
    },
    SpreadsheetApp: { create: () => book, openById: () => book },
    DriveApp: {
      Access: { DOMAIN: "DOMAIN" },
      Permission: { EDIT: "EDIT" },
      getFileById: () => ({ setSharing() {}, moveTo() {} }),
      getFolderById: () => ({}),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(gas);
  // 本番と同じ順: CloudLedger.gs → CloudLedgerLogic.gs
  vm.runInContext(`${io}\n${logic}`, gas);
  const result = gas.setupCloudLedger();
  assert.equal(result.ok, true);
  assert.deepEqual(book.created, ["プロジェクト所在地図", "クラウド契約", "PCログイン"]);
  assert.equal(properties.CLOUD_LEDGER_SHEET_ID, "sheet-id-1234567890");
});

// 実物に近いブックのスタブ。getSheetByName を持たない簡易スタブだと
// 「不足タブを補う」修復処理をテストできない(そこが実機で壊れた箇所)。
// 関数宣言なので巻き上げられ、上のテストからも参照できる。
function makeBookStub(initialTabs = [], { empty = [] } = {}) {
  const tabs = initialTabs.map((name) => ({ name, rows: empty.includes(name) ? 0 : 1 }));
  const wrap = (tab) => ({
    getName: () => tab.name,
    getLastRow: () => tab.rows,
    getLastColumn: () => (tab.rows ? 1 : 0),
    getRange: () => ({ setValues() {} }),
  });
  return {
    created: [],
    deleted: [],
    getId: () => "sheet-id-1234567890",
    getSheets: () => tabs.map(wrap),
    getSheetByName(name) {
      const tab = tabs.find((item) => item.name === name);
      return tab ? wrap(tab) : null;
    },
    insertSheet(name) {
      tabs.push({ name, rows: 1 });
      this.created.push(name);
      return wrap(tabs[tabs.length - 1]);
    },
    deleteSheet(sheet) {
      const name = sheet.getName();
      const index = tabs.findIndex((item) => item.name === name);
      if (index >= 0) tabs.splice(index, 1);
      this.deleted.push(name);
    },
  };
}

// 回帰テスト: 最初の setupCloudLedger が途中で落ち、タブ1枚＋既定「シート1」だけの
// 半端な台帳が残った(2026-08-28 実測)。既に ID がある場合に何もせず返す実装だったため、
// 再実行しても直らなかった。**再実行だけで正しい形へ寄る**ことを固定する。
test("既存の作りかけ台帳を再実行だけで修復する", () => {
  const properties = new Map([["CLOUD_LEDGER_SHEET_ID", "sheet-id-1234567890"]]);
  const book = makeBookStub(["シート1", "プロジェクト所在地図"], { empty: ["シート1"] });
  const setupContext = {
    CLOUD_PROJECT_HEADERS_: project,
    CLOUD_CONTRACT_HEADERS_: contracts,
    CLOUD_LOGIN_HEADERS_: logins,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) || "",
        setProperty: (key, value) => properties.set(key, value),
      }),
    },
    SpreadsheetApp: { openById: () => book, create: () => book },
    DriveApp: {
      Access: { DOMAIN: "DOMAIN" },
      Permission: { EDIT: "EDIT" },
      getFileById: () => ({ setSharing() {}, moveTo() {} }),
      getFolderById: () => ({}),
    },
  };
  vm.createContext(setupContext);
  vm.runInContext(io, setupContext);
  const result = setupContext.setupCloudLedger();
  assert.equal(result.createdSpreadsheet, false, "既存があるのに作り直してはいけない");
  // vm 内で作られた配列は realm が違うので、host 側の配列に写してから比較する。
  assert.deepEqual([...result.createdTabs], ["クラウド契約", "PCログイン"]);
  assert.deepEqual([...result.tabs], ["プロジェクト所在地図", "クラウド契約", "PCログイン"]);
  assert.deepEqual(book.deleted, ["シート1"]);
});

// 空でない既定シートは人が使い始めている可能性があるので消さない。
test("中身のある既定シートは消さない", () => {
  const properties = new Map([["CLOUD_LEDGER_SHEET_ID", "sheet-id-1234567890"]]);
  const book = makeBookStub(["シート1", "プロジェクト所在地図", "クラウド契約", "PCログイン"]);
  const setupContext = {
    CLOUD_PROJECT_HEADERS_: project,
    CLOUD_CONTRACT_HEADERS_: contracts,
    CLOUD_LOGIN_HEADERS_: logins,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) || "",
        setProperty: (key, value) => properties.set(key, value),
      }),
    },
    SpreadsheetApp: { openById: () => book, create: () => book },
    DriveApp: {
      Access: { DOMAIN: "DOMAIN" },
      Permission: { EDIT: "EDIT" },
      getFileById: () => ({ setSharing() {}, moveTo() {} }),
      getFolderById: () => ({}),
    },
  };
  vm.createContext(setupContext);
  vm.runInContext(io, setupContext);
  setupContext.setupCloudLedger();
  assert.deepEqual(book.deleted, []);
});

// 回帰テスト: タブは作られたがヘッダを書く前に落ちた台帳が実在した。
// 列数0のまま読むと GAS が「範囲の列数には 1 以上を指定してください」で落ち、
// **タブが揃って見えるのに全ての読み書きが失敗する**という分かりにくい壊れ方になる。
test("ヘッダの無い既存タブにヘッダを補う", () => {
  const properties = new Map([["CLOUD_LEDGER_SHEET_ID", "sheet-id-1234567890"]]);
  const book = makeBookStub(["プロジェクト所在地図"], { empty: ["プロジェクト所在地図"] });
  const setupContext = {
    CLOUD_PROJECT_HEADERS_: project,
    CLOUD_CONTRACT_HEADERS_: contracts,
    CLOUD_LOGIN_HEADERS_: logins,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) || "",
        setProperty: (key, value) => properties.set(key, value),
      }),
    },
    SpreadsheetApp: { openById: () => book, create: () => book },
    DriveApp: {
      Access: { DOMAIN: "DOMAIN" },
      Permission: { EDIT: "EDIT" },
      getFileById: () => ({ setSharing() {}, moveTo() {} }),
      getFolderById: () => ({}),
    },
  };
  vm.createContext(setupContext);
  vm.runInContext(io, setupContext);
  const result = setupContext.setupCloudLedger();
  assert.deepEqual([...result.repairedTabs], ["プロジェクト所在地図"]);
  assert.deepEqual([...result.createdTabs], ["クラウド契約", "PCログイン"]);
});
