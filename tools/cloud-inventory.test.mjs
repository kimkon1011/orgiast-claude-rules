import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseGhAuthStatus,
  parseVercelWhoami,
  parseGcloudAuthList,
  parseNpmWhoami,
  formatCloudTable,
  buildCloudLoginPayload,
  safeEnvironmentNames,parseVercelTeams,
  collectCloudInventory,
} from "./cloud-inventory.mjs";

test("parsers classify accounts without inventing unavailable state", () => {
  assert.deepEqual(
    parseGhAuthStatus("Logged in to github.com account kimkon1011 (keyring)"),
    [
      {
        service: "GitHub",
        account: "kimkon1011",
        scope: "github.com",
        source: "gh auth status",
        status: "ログイン済み",
      },
    ],
  );
  assert.equal(parseVercelWhoami("Vercel CLI 50\nkimkon1011\n"), "kimkon1011");
  assert.equal(parseGcloudAuthList("svc@example.com *")[0].active, true);
  assert.equal(parseNpmWhoami("npm ERR! ENEEDAUTH", 1).status, "未ログイン");
  assert.equal(parseNpmWhoami("timeout", 1).status, "判定不能");
});
test("payload and table expose only allowlisted fields", () => {
  const rows = [{ service: "GitHub", account: "kim", status: "ログイン済み" }];
  assert.match(formatCloudTable(rows), /GitHub/);
  assert.deepEqual(
    Object.keys(buildCloudLoginPayload(rows, { label: "PC" }).rows[0]),
    ["service", "account", "scope", "source", "status", "version"],
  );
  assert.deepEqual(
    safeEnvironmentNames({ PATH: "x", API_TOKEN: "secret", PASSWORD: "x" }),
    ["PATH"],
  );
});
test("missing optional CLIs are noise, required CLIs remain visible", async () => {
  const rows = await collectCloudInventory({
    exists: () => false,
    run: () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    home: "/absent",
  });
  assert.deepEqual(
    rows.map((row) => row.service),
    ["GitHub", "Vercel", "Google Cloud"],
  );
});
test("source never reads credential-bearing files or environment values", () => {
  const source = fs.readFileSync(
    new URL("./cloud-inventory.mjs", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "hosts.yml",
    "oauth_token",
    ".aws/credentials",
    ".netrc",
    ".env.local",
    "keyserve",
  ])
    assert(!source.includes(forbidden), forbidden);
  assert(!/readFileSync\s*\(\s*claspPath/.test(source));
  assert(!/process\.env\s*\[/.test(source));
});

// 回帰テスト: `vercel teams ls` も表を stderr に出し、進捗行と見出し行が混ざる。
// 素朴に slice(1) すると進捗行が「所属チーム」として台帳に載る。
test("parseVercelTeams は進捗行と見出しを捨ててチームIDだけ返す", () => {
  const output = [
    "Fetching teams",
    "Fetching user information",
    "",
    "  id                    Team name",
    "√ kimkon-s-projects     Kimkon's projects",
  ].join("\n");
  assert.deepEqual(parseVercelTeams(output), ["kimkon-s-projects"]);
  // 見出しが無い出力から推測で拾わない(誤った所属を台帳に書かない)。
  assert.deepEqual(parseVercelTeams("Fetching teams\nsomething else"), []);
});
