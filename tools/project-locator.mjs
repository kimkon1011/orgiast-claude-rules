#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectProjectInventory,
  summarizeProjects,
} from "./project-inventory.mjs";
import { parseGhAuthStatus, runCloudCommand } from "./cloud-inventory.mjs";
import { parseEnvText } from "./env-kv.mjs";
import { resolveReporterLabel } from "./reporter-label.mjs";
import { isEntry } from "./is-entry.mjs";

// 台帳の「開発PC」は PCログインタブの「PC名/ホスト名」と同じ値でなければ突合できない。
// os.hostname() を直に使うと両タブで別名になり、探し物が見つからない原因そのものになる。
function defaultLabel() {
  const envPath = path.join(os.homedir(), ".claude", "cost-reporter.env");
  let envText = "";
  try {
    envText = fs.readFileSync(envPath, "utf8");
  } catch {
    // cost-reporter.env が未配布のPCでも hostname にフォールバックして続行する。
  }
  return resolveReporterLabel({ envText, hostname: os.hostname() }).label;
}

const clean = (value) => String(value ?? "").trim();

export function parseVercelProjects(text) {
  const source = String(text);
  const scopeMatch = source.match(
    /(?:Fetching projects in|Projects found under)\s+([^\s[]+)/i,
  );
  const scope = scopeMatch ? scopeMatch[1] : "";

  return source
    .split(/\r?\n/)
    .map(clean)
    .filter(
      (line) =>
        line &&
        !/^(?:Vercel CLI|Fetching projects in|>\s*Projects found under|Project Name|-{2,})/i.test(
          line,
        ),
    )
    .map((line) => {
      const parts = line
        .split(/\s{2,}/)
        .map(clean)
        .filter(Boolean);
      const prodUrl =
        parts.find((value) =>
          /^(?:https?:\/\/|\S+\.vercel\.app)/i.test(value),
        ) || "";
      return {
        name: parts[0] || "",
        prodUrl: prodUrl.replace(/^https?:\/\//, ""),
        scope,
      };
    })
    .filter((item) => /^[\w.-]+$/.test(item.name));
}

function formatJst(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

export function mergeProjectLocations(
  repos,
  vercel,
  local,
  label,
  now = new Date(),
) {
  const byName = new Map(vercel.map((item) => [item.name, item]));
  const localByName = new Map(
    summarizeProjects(local, 200)
      .filter((item) => item.repoName)
      .map((item) => [item.repoName, item]),
  );
  const matchedVercel = new Set();

  const rows = repos.map((repo) => {
    const name =
      repo.name ||
      String(repo.nameWithOwner || "")
        .split("/")
        .pop();
    const deployment = byName.get(name);
    const nearby = localByName.get(name);
    if (deployment) matchedVercel.add(deployment.name);
    return {
      project: name,
      repo: repo.nameWithOwner || "",
      ghAccount: String(repo.nameWithOwner || "").split("/")[0],
      visibility: String(repo.visibility || "").toLowerCase(),
      prodUrl: repo.homepageUrl || deployment?.prodUrl || "",
      vercelProject: deployment?.name || "",
      vercelScope: deployment?.scope || "",
      devPc: nearby ? label : "",
      localName: nearby?.project || "",
      lastCommit:
        nearby?.lastCommitAt && nearby?.lastCommitSubject
          ? `${nearby.lastCommitAt.slice(0, 10)} ${[...nearby.lastCommitSubject].slice(0, 60).join("")}`
          : "",
      updatedAt: formatJst(now),
    };
  });

  // GitHub と結び付かない本番こそ迷子候補なので、Vercel 単独でも必ず台帳へ出す。
  vercel
    .filter((item) => !matchedVercel.has(item.name))
    .forEach((item) => {
      rows.push({
        project: item.name,
        repo: "",
        ghAccount: "",
        visibility: "",
        prodUrl: item.prodUrl || "",
        vercelProject: item.name,
        vercelScope: item.scope || "",
        devPc: "",
        localName: "",
        lastCommit: "",
        updatedAt: formatJst(now),
      });
    });
  return rows;
}

// 実行は cloud-inventory の共有ランナーに任せる。Windows の .cmd シム対応を
// ここで再実装すると、片方だけ直って片方が黙って空を返す状態に戻る。
const run = (command, args) => runCloudCommand(command, args, 30000);

export function collectProjectLocations(options = {}) {
  const runner = options.runner || run;
  const label = options.label || defaultLabel();
  const projectsDir =
    options.projectsDir || path.join(os.homedir(), ".claude", "projects");
  const now = options.now || new Date();
  const auth = runner("gh", ["auth", "status"]);
  const accounts = parseGhAuthStatus(`${auth.stdout}\n${auth.stderr}`).map(
    (row) => row.account,
  );
  if (!accounts.length) {
    throw new Error(
      "GitHub APIを利用できません: gh auth status からアカウントを取得できません",
    );
  }

  // org の列挙に失敗しても、認証済みの個人アカウント分は失わず続行する。
  const orgResult = runner("gh", ["api", "user/orgs", "--jq", ".[].login"]);
  const orgs =
    orgResult.code === 0
      ? orgResult.stdout.split(/\r?\n/).map(clean).filter(Boolean)
      : [];
  const repos = [];
  for (const owner of [...new Set([...accounts, ...orgs])]) {
    const result = runner("gh", [
      "repo",
      "list",
      owner,
      "--json",
      "name,nameWithOwner,visibility,homepageUrl,pushedAt,description",
      "--limit",
      "200",
    ]);
    if (result.code !== 0) {
      if (accounts.includes(owner))
        throw new Error(`GitHub APIを利用できません (${owner})`);
      console.error(
        `project-locator: GitHub Organization を取得できません (${owner})`,
      );
      continue;
    }
    repos.push(...JSON.parse(result.stdout));
  }

  // Vercel CLI は一覧を **stderr** に書く。stdout だけ読むと終了コード0のまま
  // 0件になり、「成功したのに何も出ない」という一番気付けない壊れ方をする(実測)。
  const vercelResult = runner("vercel", ["project", "ls"]);
  const vercel =
    vercelResult.code === 0
      ? parseVercelProjects(`${vercelResult.stdout}\n${vercelResult.stderr}`)
      : [];
  if (vercelResult.code !== 0) {
    // 取得不能を「プロジェクトなし」と断定せず、GitHub 分だけで継続する。
    console.error("project-locator: Vercel API/CLIから一覧を取得できません");
  }
  const local = collectProjectInventory({ projectsDir, limit: 200 });
  return mergeProjectLocations(repos, vercel, local, label, now);
}

async function main() {
  const projects = collectProjectLocations();
  if (!process.argv.includes("--send")) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  const envPath = path.join(os.homedir(), ".claude", "fleet-sheet.env");
  const env = parseEnvText(fs.readFileSync(envPath, "utf8"));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN)
    throw new Error("FLEET_SHEET_URL/TOKEN 未設定");
  const response = await fetch(env.FLEET_SHEET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: env.FLEET_SHEET_TOKEN,
      kind: "cloud-project",
      projects,
    }),
  });
  if (!response.ok) throw new Error(`送信失敗 HTTP ${response.status}`);
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`project-locator: ${error.message}`);
    process.exitCode = 1;
  });
}
