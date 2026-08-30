import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const logic = fs.readFileSync(
  new URL("../gas/fleet-status-sheet/LedgerUnifyLogic.gs", import.meta.url),
  "utf8",
);
const context = {};
vm.createContext(context);
vm.runInContext(logic.replace(/\bconst\s+/g, "var "), context);

test("a second tab plan copies nothing", () => {
  const targets = ["稼働状況", "拡張機能監査"];
  const first = context.unifyPlanTabs(targets, [], targets);
  assert.deepEqual([...first.toCopy], targets);
  const second = context.unifyPlanTabs(targets, first.toCopy, targets);
  assert.deepEqual([...second.toCopy], []);
  assert.deepEqual([...second.toSkip], targets);
});

test("migrated source names are never processed twice", () => {
  const plan = context.unifyPlanTabs(["【移行済】稼働状況"], [], ["【移行済】稼働状況"]);
  assert.deepEqual([...plan.toCopy], []);
});

test("legacy prefix is idempotent", () => {
  assert.equal(context.unifyLegacyTabName("稼働状況"), "【移行済】稼働状況");
  assert.equal(context.unifyLegacyTabName("【移行済】稼働状況"), "【移行済】稼働状況");
});

test("index has no payment fields or secret values", () => {
  const rows = context.buildIndexRows(["実際の稼働状況"], "ledger-id", "inventory-id", "legacy-id");
  const serialized = JSON.stringify(rows);
  assert.match(serialized, /実際の稼働状況/);
  assert(!serialized.includes("支払い元カード(下4桁)"));
  assert(!serialized.includes("支払い元(名義)"));
  assert(!serialized.includes("1234"));
});

test("missing PC inventory ID is shown as unset", () => {
  const rows = context.buildIndexRows(["稼働状況"], "ledger-id", "", "legacy-id");
  const inventory = rows.find((row) => row[0] === "PC管理表(備品管理表関係データ保管用)");
  assert.equal(inventory[1], "(未設定)");
});

test("the fleet tab is renamed on the ledger side", () => {
  assert.equal(context.unifyDestTabName("Untitled", "Untitled"), "PC稼働状況");
  assert.equal(context.unifyDestTabName("拡張機能監査", "Untitled"), "拡張機能監査");
});

// 改名して移すので、2回目の判定は「移行先での名前」で行わないと同じタブを二重に作る。
test("a rerun after the rename copies nothing", () => {
  const targets = ["Untitled", "拡張機能監査"];
  const first = context.unifyPlanTabs(targets, [], targets, "Untitled");
  assert.deepEqual([...first.toCopy], targets);
  const destAfter = first.toCopy.map((name) => context.unifyDestTabName(name, "Untitled"));
  assert.deepEqual([...destAfter], ["PC稼働状況", "拡張機能監査"]);
  const second = context.unifyPlanTabs(targets, destAfter, targets, "Untitled");
  assert.deepEqual([...second.toCopy], []);
});

test("the index names the renamed fleet tab", () => {
  const rows = context.buildIndexRows(["PC稼働状況"], "ledger-id", "inventory-id", "legacy-id");
  assert(rows.some((row) => row[0] === "PC稼働状況"));
  assert(!JSON.stringify(rows).includes("Untitled"));
});
