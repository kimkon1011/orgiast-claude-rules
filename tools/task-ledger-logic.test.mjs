import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const logic = fs.readFileSync(
  new URL("../gas/task-sheet/TaskLedgerLogic.gs", import.meta.url),
  "utf8",
);
const context = {};
vm.createContext(context);
vm.runInContext(logic.replace(/\bconst\s+/g, "var "), context);

const headers = [
  "taskId", "起票元", "件名", "依頼元", "担当PC", "状態", "次アクション",
  "成果物リンク", "期限", "最終更新", "備考",
];
const row = (values = {}) => headers.map((header) => values[header] ?? "");

test("upsert inserts a new task as a complete row", () => {
  const plan = context.taskLedgerPlanUpsert(headers, [], {
    taskId: "task-1",
    件名: "新規タスク",
  }, "2026-09-03T00:00:00.000Z");

  assert.equal(plan.action, "insert");
  assert.equal(plan.rowIndex, 0);
  assert.equal(plan.row[headers.indexOf("taskId")], "task-1");
  assert.equal(plan.row[headers.indexOf("件名")], "新規タスク");
  assert.equal(plan.row[headers.indexOf("状態")], "未着手");
  assert.equal(plan.row[headers.indexOf("最終更新")], "2026-09-03T00:00:00.000Z");
});

test("upsert replaces the whole existing row but preserves omitted status", () => {
  const existing = row({
    taskId: "task-1",
    起票元: "old-source",
    件名: "old-title",
    状態: "保留",
    備考: "old-note",
  });
  const plan = context.taskLedgerPlanUpsert(headers, [existing], {
    taskId: "task-1",
    件名: "new-title",
  }, "now");

  assert.equal(plan.action, "update");
  assert.equal(plan.rowIndex, 0);
  assert.equal(plan.row[headers.indexOf("件名")], "new-title");
  assert.equal(plan.row[headers.indexOf("起票元")], "");
  assert.equal(plan.row[headers.indexOf("備考")], "");
  assert.equal(plan.row[headers.indexOf("状態")], "保留");
});

test("claim succeeds only for an unowned task", () => {
  const plan = context.taskLedgerPlanClaim(headers, [row({ taskId: "task-1" })], {
    taskId: "task-1",
    担当PC: "PC-A",
  }, "now");

  assert.equal(plan.ok, true);
  assert.equal(plan.rowIndex, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.updates)), [
    { column: "担当PC", value: "PC-A" },
    { column: "状態", value: "実行中" },
    { column: "最終更新", value: "now" },
  ]);
});

test("claim rejects an already claimed task with its owner", () => {
  const plan = context.taskLedgerPlanClaim(headers, [row({ taskId: "task-1", 担当PC: "PC-A" })], {
    taskId: "task-1",
    担当PC: "PC-B",
  }, "now");

  assert.equal(plan.ok, false);
  assert.equal(plan.error, "already_claimed");
  assert.equal(plan.owner, "PC-A");
});

test("claim returns not_found for an unknown task", () => {
  const plan = context.taskLedgerPlanClaim(headers, [], { taskId: "missing", 担当PC: "PC-A" }, "now");
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "not_found");
});

test("done completes a task without clearing an omitted artifact link", () => {
  const plan = context.taskLedgerPlanDone(headers, [row({
    taskId: "task-1",
    成果物リンク: "https://example.test/keep",
  })], { taskId: "task-1", 備考: "done" }, "now");

  assert.equal(plan.ok, true);
  assert(plan.updates.some((update) => update.column === "状態" && update.value === "完了"));
  assert(!plan.updates.some((update) => update.column === "成果物リンク"));
  assert(plan.updates.some((update) => update.column === "備考" && update.value === "done"));
});

test("done returns not_found for an unknown task", () => {
  const plan = context.taskLedgerPlanDone(headers, [], { taskId: "missing" }, "now");
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "not_found");
});

test("filter rows applies exact status and owner matches", () => {
  const rows = [
    { taskId: "1", 状態: "実行中", 担当PC: "PC-A" },
    { taskId: "2", 状態: "完了", 担当PC: "PC-A" },
    { taskId: "3", 状態: "実行中", 担当PC: "PC-B" },
  ];
  const filtered = context.taskLedgerFilterRows(rows, { 状態: "実行中", 担当PC: "PC-A" });
  assert.deepEqual(JSON.parse(JSON.stringify(filtered)), [rows[0]]);
});
