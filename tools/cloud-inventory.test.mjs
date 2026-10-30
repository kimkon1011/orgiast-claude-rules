import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseGhAuthStatus,
  parseVercelWhoami,
  parseGcloudAuthList,
  parseNpmWhoami,
  formatCloudTable,
  buildCloudLoginPayload,
  safeEnvironmentNames,parseVercelTeams,
  collectCloudInventory,
  collectAiLaneLogins,
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
    rows.slice(0, 3).map((row) => row.service),
    ["GitHub", "Vercel", "Google Cloud"],
  );
  assert.equal(rows.length, 13);
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

test("AI lane rows expose only key suffixes and login account metadata", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-inventory-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const secrets = {
    gemini: "gemini-secret-C-Hs", deepseek: "openrouter-secret-OR99",
    glm: "zai-secret-ZA11", groq: "groq-secret-GR22", mistral: "mistral-secret-MI33",
    grok: "xai-secret-XA44", kimi: "moonshot-secret-KI55",
  };
  fs.writeFileSync(path.join(home, ".gemini", ".env"), `GEMINI_API_KEY=${secrets.gemini}\n`);
  for (const [file, variable, key] of [
    ["openrouter.env", "OPENROUTER_API_KEY", secrets.deepseek], ["zai.env", "ZAI_API_KEY", secrets.glm],
    ["groq.env", "GROQ_API_KEY", secrets.groq], ["mistral.env", "MISTRAL_API_KEY", secrets.mistral],
    ["xai.env", "XAI_API_KEY", secrets.grok], ["kimi-api.env", "MOONSHOT_API_KEY", secrets.kimi],
  ]) fs.writeFileSync(path.join(home, ".claude", file), `${variable}=${key}\n`);
  const payload = Buffer.from(JSON.stringify({ email: "codex@example.com" })).toString("base64url");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: `x.${payload}.signature-secret` } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "claude@example.com", organizationName: "Org" } }));
  const rows = collectAiLaneLogins({ home, readLaneHealth: () => ({ lanes: { gemini: { alive: true }, groq: { alive: false, reason: "quota_wait" } } }) });
  assert.deepEqual(rows.find((r) => r.service === "安いAI: Gemini"), {
    service: "安いAI: Gemini", account: "seisaku-team@orgiast.jp", scope: "鍵 …C-Hs", source: ".gemini/.env", status: "稼働", version: "",
  });
  assert.equal(rows.find((r) => r.service === "安いAI: Groq").status, "停止(quota_wait)");
  assert.equal(rows.find((r) => r.service === "安いAI: GLM").account, "所有者未登録(鍵 …ZA11)");
  assert.equal(rows.find((r) => r.service === "安いAI: Codex").account, "codex@example.com");
  assert.deepEqual(rows.find((r) => r.service === "Claude Code"), {
    service: "Claude Code", account: "claude@example.com", scope: "Org", source: ".claude.json", status: "ログイン済み", version: "",
  });
  const serialized = JSON.stringify(rows);
  for (const secret of Object.values(secrets)) assert(!serialized.includes(secret));
  assert(!serialized.includes("signature-secret"));
  fs.rmSync(home, { recursive: true, force: true });
});
