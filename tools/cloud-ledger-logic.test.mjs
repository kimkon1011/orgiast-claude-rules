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

test("contract never writes payment columns and force controls nonempty overwrite", () => {
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
  for (const forbidden of ["支払い元カード(下4桁)", "支払い元(名義)"]) {
    assert(
      !forced.updates.some(
        (update) => contracts[update.columnIndex - 1] === forbidden,
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

test("describe response contains keys but never payment values", () => {
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
  const serialized = JSON.stringify(fake.describeCloudLedger());
  assert.match(serialized, /kim\/app/);
  assert(!serialized.includes("9876"));
  assert(!serialized.includes("SECRET NAME"));
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
      create: () => ({
        getId: () => "sheet-id-1234567890",
        getSheets: () => [{ getName: () => "シート1" }],
        insertSheet: (name) => {
          createdSheets.push(name);
          return { getRange: () => ({ setValues() {} }) };
        },
        deleteSheet() {},
      }),
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
  const created = { sheets: [], name: "" };
  const sheetStub = () => ({
    getRange: () => ({ setValues() {}, getDisplayValues: () => [[]] }),
    getName: () => "tab",
    getLastColumn: () => 0,
    getLastRow: () => 1,
  });
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
    SpreadsheetApp: {
      create: (name) => {
        created.name = name;
        return {
          getId: () => "NEWID1234567890",
          getSheets: () => [sheetStub()],
          insertSheet: (tab) => {
            created.sheets.push(tab);
            return sheetStub();
          },
          deleteSheet() {},
        };
      },
    },
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
  assert.deepEqual(created.sheets, ["プロジェクト所在地図", "クラウド契約", "PCログイン"]);
  assert.equal(properties.CLOUD_LEDGER_SHEET_ID, "NEWID1234567890");
});
