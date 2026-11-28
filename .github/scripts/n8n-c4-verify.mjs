import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const WORKDIR = process.env.WORKDIR;

// ---- Candidate definitions ----
const CANDIDATES = [
  { idx:0, prefix:"Forms_and_Surveys/Qualifying Appointment Requests with AI", expected:25 },
  { idx:1, prefix:"Other_Integrations_and_Use_Cases/ClientFlow Lite",           expected:6  },
  { idx:2, prefix:"Gmail_and_Email_Automation/Gmail AI Auto-Responder",         expected:12 },
  { idx:3, prefix:"Gmail_and_Email_Automation/Compose reply draft in Gmail with OpenAI Assistant", expected:23 },
  { idx:4, prefix:"Notion/Turn Emails into AI-Enhanced Tasks in Notion",         expected:38 },
];

// ---- Phase 1: fetch tree, resolve paths ----
const treeUrl = "https://api.github.com/repos/enescingoz/awesome-n8n-templates/git/trees/827110332c21cbe000ab13f6d292d5adb1f1f8db?recursive=1";
const resp = await fetch(treeUrl);
if (!resp.ok) throw new Error(`Tree fetch failed: HTTP ${resp.status}`);
const tree = (await resp.json()).tree;
const blobEntries = tree.filter(e => e.type === "blob" && e.path.endsWith(".json"));

const resolved = [];
const failures = [];

for (const c of CANDIDATES) {
  const escaped = c.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped + ".*\\.json$");
  const match = blobEntries.find(e => re.test(e.path));
  if (match) {
    resolved.push({ ...c, path: match.path, url: match.url });
  } else {
    failures.push({ prefix: c.prefix, issue: "path_not_resolved" });
  }
}

// ---- Phase 2: fetch each JSON, deactivate active, save ----
const saved = [];
for (const r of resolved) {
  const blobResp = await fetch(r.url);
  if (!blobResp.ok) {
    failures.push({ prefix: r.prefix, issue: "fetch_failed (HTTP " + blobResp.status + ")" });
    continue;
  }
  let wf = await blobResp.json();
  if (wf.active === true) wf.active = false;
  const outPath = join(WORKDIR, "candidate_" + r.idx + ".json");
  writeFileSync(outPath, JSON.stringify(wf, null, 2));
  saved.push({ ...r, savedPath: outPath });
}

writeFileSync(join(WORKDIR, "resolve-result.json"), JSON.stringify({ resolved: saved, failures }, null, 2));
console.log("Phase 1-2: resolved " + saved.length + ", failures " + failures.length);
if (failures.length > 0) {
  for (const f of failures) console.error("  FAIL resolve: " + f.prefix + " — " + f.issue);
  process.exit(1);
}

// ---- Phase 3: install n8n ----
execSync("npm init -y", { cwd: WORKDIR, stdio: "pipe" });
console.log("Installing n8n (may take a few minutes)...");
execSync("npm install n8n", { cwd: WORKDIR, stdio: "inherit" });
console.log("n8n installed.");

// ---- Phase 4: import + export + assert ----
const N8N_USER = join(WORKDIR, "n8n-user");
execSync("mkdir -p " + N8N_USER, { stdio: "pipe" });
const childEnv = { ...process.env, N8N_USER_FOLDER: N8N_USER };

const results = [];
let allOk = true;

for (const r of saved) {
  const importCmd = "n8n import:workflow --input=" + r.savedPath;
  const exportDir = join(WORKDIR, "export_" + r.idx);
  const row = { name: r.prefix, path: r.path, import: "FAIL", expected: r.expected, actual: null, verdict: "FAIL" };

  try {
    execSync(importCmd, { cwd: WORKDIR, env: childEnv, stdio: "pipe", timeout: 60000 });
    row.import = "OK";
  } catch (e) {
    row.import = "FAIL";
    row.importError = (e.stderr || "").toString().substring(0, 200);
    allOk = false;
    results.push(row);
    continue;
  }

  try {
    execSync("mkdir -p " + exportDir, { stdio: "pipe" });
    execSync("n8n export:workflow --all --output=" + exportDir, { cwd: WORKDIR, env: childEnv, stdio: "pipe", timeout: 60000 });
  } catch (e) {
    row.import = "export_fail";
    allOk = false;
    results.push(row);
    continue;
  }

  // Count nodes in exported files
  const exportFiles = readdirSync(exportDir).filter(f => f.endsWith(".json"));
  let totalNodes = 0;
  for (const ef of exportFiles) {
    const data = JSON.parse(readFileSync(join(exportDir, ef), "utf8"));
    if (Array.isArray(data)) {
      totalNodes += data.length;
    } else if (data.nodes) {
      totalNodes += data.nodes.length;
    }
  }
  row.actual = totalNodes;
  row.verdict = totalNodes === r.expected ? "PASS" : "FAIL";
  if (row.verdict === "FAIL") allOk = false;
  results.push(row);
}

// Write step summary
const sumPath = process.env.GITHUB_STEP_SUMMARY;
if (sumPath) {
  let md = "| 候補 | 解決パス | import 成否 | 期待ノード数 | 実ノード数 | 判定 |\n|---|---|---|---|---|---|\n";
  for (const l of results) {
    md += "| " + l.name + " | " + (l.path || "-") + " | " + l.import + " | " + l.expected + " | " + (l.actual ?? "-") + " | " + l.verdict + " |\n";
  }
  writeFileSync(sumPath, md, "utf8");
}

writeFileSync(join(WORKDIR, "verify-result.json"), JSON.stringify(results, null, 2), "utf8");
console.log("verify.mjs complete. allOk=" + allOk);

if (!allOk) {
  for (const l of results) {
    if (l.verdict === "FAIL") console.error("  FAIL: " + l.name + " — expected " + l.expected + " nodes, got " + (l.actual ?? "N/A") + (l.importError ? " (import: " + l.importError + ")" : ""));
  }
  process.exit(1);
}
console.log("All 5 candidates verified successfully.");
process.exit(0);
