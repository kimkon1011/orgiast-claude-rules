import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recordClosed } from "./closed-sessions-ledger.mjs";

function ledgerPath() {
  return join(mkdtempSync(join(tmpdir(), "closed-ledger-")), "closed-sessions.json");
}

function ids(path) {
  return JSON.parse(readFileSync(path, "utf8")).ids;
}

test("台帳が無ければ作って ID を1件書く", () => {
  const path = ledgerPath();
  assert.equal(recordClosed("aaa", path), true);
  assert.deepEqual(ids(path), ["aaa"]);
});

test("既存の ID を消さずに追記する", () => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ ids: ["old"] }), "utf8");
  assert.equal(recordClosed("new", path), true);
  assert.deepEqual(ids(path), ["old", "new"]);
});

test("同じ ID を二重に積まない", () => {
  const path = ledgerPath();
  recordClosed("aaa", path);
  assert.equal(recordClosed("aaa", path), true);
  assert.deepEqual(ids(path), ["aaa"]);
});

test("壊れた JSON でも書き直して成功する", () => {
  const path = ledgerPath();
  writeFileSync(path, "{ こわれている", "utf8");
  assert.equal(recordClosed("aaa", path), true);
  assert.deepEqual(ids(path), ["aaa"]);
});

test("true を返したときは必ず実ファイルに ID が載っている（読み戻しの契約）", () => {
  // 旧実装はここを確かめずに成功を返していたため、並行して閉じた別セッションの
  // 上書きに競り負けると「成功したのに台帳に無い」状態になった（2026-09-22 実害）。
  const path = ledgerPath();
  for (const id of ["a", "b", "c"]) {
    assert.equal(recordClosed(id, path), true, `${id} の記録が false を返した`);
    assert.ok(ids(path).includes(id), `${id} が true なのに台帳に無い`);
  }
  assert.deepEqual(ids(path), ["a", "b", "c"]);
});

test("他プロセスが横から書いた ID を巻き戻さない", () => {
  const path = ledgerPath();
  recordClosed("mine", path);
  // 別プロセスが後から追記した状況
  writeFileSync(path, JSON.stringify({ ids: ["mine", "theirs"] }), "utf8");
  // 同じ ID をもう一度閉じても、相手の ID を消さない
  assert.equal(recordClosed("mine", path), true);
  assert.deepEqual(ids(path), ["mine", "theirs"]);
});

test("書き込みに失敗し続けたら false を返し、例外を握り潰さない", () => {
  // 存在しないディレクトリ配下を指す = rename が必ず失敗する。
  const path = join(tmpdir(), "closed-ledger-missing-dir", "nope", "closed-sessions.json");
  const seen = [];
  assert.equal(recordClosed("aaa", path, { attempts: 2, onError: (e) => seen.push(e) }), false);
  assert.equal(seen.length, 1);
});

test("上限を超えたら古い ID から捨てる", () => {
  const path = ledgerPath();
  writeFileSync(path, JSON.stringify({ ids: Array.from({ length: 500 }, (_, i) => `id${i}`) }), "utf8");
  assert.equal(recordClosed("newest", path), true);
  const after = ids(path);
  assert.equal(after.length, 500);
  assert.equal(after.at(-1), "newest");
  assert.equal(after.includes("id0"), false);
});
