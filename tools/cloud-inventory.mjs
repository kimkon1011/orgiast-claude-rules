#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isEntry } from "./is-entry.mjs";

const text = (value) => String(value ?? "").trim();
export function parseGhAuthStatus(value) {
  return [
    ...String(value).matchAll(/Logged in to\s+(\S+)\s+account\s+([^\s(]+)/gi),
  ].map((match) => ({
    service: "GitHub",
    account: match[2],
    scope: match[1],
    source: "gh auth status",
    status: "ログイン済み",
  }));
}
export function parseVercelWhoami(value) {
  const lines = String(value)
    .split(/\r?\n/)
    .map(text)
    .filter(Boolean)
    .filter((line) => !/^vercel cli/i.test(line));
  return lines.length ? lines[lines.length - 1] : "";
}
export function parseGcloudAuthList(value) {
  return String(value)
    .split(/\r?\n/)
    .map(text)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[\t, ]+/);
      return {
        account: parts[0] || "",
        active:
          parts.slice(1).join(" ").includes("*") ||
          parts.slice(1).join(" ").toUpperCase().includes("ACTIVE"),
      };
    });
}
export function parseNpmWhoami(value, exitCode) {
  if (exitCode === 0 && text(value))
    return {
      account: text(value).split(/\r?\n/).pop(),
      status: "ログイン済み",
    };
  return {
    account: "",
    status: /ENEEDAUTH|not logged in/i.test(String(value))
      ? "未ログイン"
      : "判定不能",
  };
}
export function formatCloudTable(rows) {
  const columns = [
    "サービス",
    "アカウント",
    "スコープ/組織",
    "状態",
    "CLIバージョン",
  ];
  const body = rows.map((row) =>
    [row.service, row.account, row.scope, row.status, row.version].map(
      (v) => text(v) || "-",
    ),
  );
  const widths = columns.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  return [columns, ...body]
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" | "))
    .join("\n");
}
export function buildCloudLoginPayload(rows, identity) {
  return {
    kind: "cloud-login",
    label: text(identity.label),
    hostname: text(identity.hostname),
    username: text(identity.username),
    reportedAt: text(identity.reportedAt),
    rows: rows.map(
      ({
        service,
        account = "",
        scope = "",
        source = "",
        status = "判定不能",
        version = "",
      }) => ({ service, account, scope, source, status, version }),
    ),
  };
}
// `vercel teams ls` の表は stderr 側に出て、進捗行(Fetching …)と見出し行が混ざる。
// 見出し `Team name` より後ろの行だけを対象にし、現在のスコープを示す記号(√ 等)を
// 落として id を取る。見出しが見つからない場合は空を返す(推測で拾わない)。
export function parseVercelTeams(value) {
  const lines = String(value).split(/\r?\n/).map(text).filter(Boolean);
  const headerIndex = lines.findIndex((line) => /Team\s*name/i.test(line));
  if (headerIndex < 0) return [];
  return lines
    .slice(headerIndex + 1)
    .map((line) => line.replace(/^[^\w]+/, "").split(/\s{2,}/)[0])
    .map(text)
    .filter((id) => /^[\w.-]+$/.test(id));
}

export function safeEnvironmentNames(env) {
  return Object.keys(env || {}).filter(
    (name) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name),
  );
}

// Windows の `vercel` / `npm` などは .cmd シムなので spawnSync から直接起動できず
// ENOENT になる。ここを共有せずに各ツールが素の spawnSync を書くと、
// 「CLI は動くのにツールからだけ取得できない」という気付きにくい欠落になる
// (実際 project-locator が Vercel を毎回「取得不能」と報告していた)。
export function runCloudCommand(command, args = [], timeout = 10000) {
  const cmdShims = new Set([
    "vercel",
    "gcloud",
    "npm",
    "clasp",
    "wrangler",
    "firebase",
    "netlify",
    "railway",
    "heroku",
  ]);
  const useCmd = process.platform === "win32" && cmdShims.has(command);
  const executable = useCmd ? "cmd.exe" : command;
  const commandArgs = useCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  return {
    code: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
  };
}
function defaultExists(command, run = runCloudCommand) {
  const result = run(
    process.platform === "win32" ? "where" : "which",
    [command],
    3000,
  );
  return result.code === 0;
}
function versionOf(command, run) {
  const result = run(command, ["--version"]);
  return result.code === 0
    ? text(result.stdout || result.stderr).split(/\r?\n/)[0]
    : "";
}
export async function collectCloudInventory({
  run = runCloudCommand,
  exists = (command) => defaultExists(command, run),
  home = os.homedir(),
} = {}) {
  const started = Date.now();
  const underlyingRun = run;
  // 台数分の夜間処理が詰まらないよう、個別10秒に加えて収集全体も60秒未満で打ち切る。
  run = (command, args = [], timeout = 10000) => {
    const remaining = 59000 - (Date.now() - started);
    return remaining <= 0
      ? { code: null, stdout: "", stderr: "", timedOut: true }
      : underlyingRun(command, args, Math.min(timeout, remaining));
  };
  const rows = [];
  const add = (row) =>
    rows.push({
      account: "",
      scope: "",
      source: "",
      status: "判定不能",
      version: "",
      ...row,
    });
  const requiredServices = {
    gh: "GitHub",
    vercel: "Vercel",
    gcloud: "Google Cloud",
  };
  for (const command of Object.keys(requiredServices)) {
    if (!exists(command)) {
      add({
        service: requiredServices[command],
        source: "CLI確認",
        status: "CLI無し",
      });
    }
  }
  if (exists("gh")) {
    const r = run("gh", ["auth", "status"]);
    const parsed = parseGhAuthStatus(r.stdout + "\n" + r.stderr);
    if (parsed.length)
      parsed.forEach((row) => add({ ...row, version: versionOf("gh", run) }));
    else
      add({
        service: "GitHub",
        source: "gh auth status",
        status: "判定不能",
        version: versionOf("gh", run),
      });
  }
  if (exists("git")) {
    const r = run("git", ["config", "--global", "user.email"]);
    if (r.code === 0 && text(r.stdout))
      add({
        service: "GitHub(git)",
        account: text(r.stdout),
        source: "git config --global user.email",
        status: "設定済み",
        version: versionOf("git", run),
      });
  }
  if (exists("vercel")) {
    const r = run("vercel", ["whoami"]);
    const account = parseVercelWhoami(r.stdout);
    let scope = "";
    // Vercel CLI は表を stderr に書くので、stdout だけ見ると常に空になる。
    const teams = run("vercel", ["teams", "ls"]);
    if (teams.code === 0)
      scope = parseVercelTeams(`${teams.stdout}\n${teams.stderr}`).join(", ");
    add({
      service: "Vercel",
      account,
      scope,
      source: "vercel whoami",
      status: r.code === 0 && account ? "ログイン済み" : "判定不能",
      version: versionOf("vercel", run),
    });
  }
  if (exists("gcloud")) {
    const auth = run("gcloud", [
      "auth",
      "list",
      "--format=value(account,status)",
    ]);
    const project = run("gcloud", ["config", "get-value", "project"]);
    const accounts = parseGcloudAuthList(auth.stdout);
    if (accounts.length)
      accounts.forEach((item) =>
        add({
          service: "Google Cloud",
          account: item.account,
          scope: project.code === 0 ? text(project.stdout) : "",
          source: "gcloud auth list",
          status: item.active ? "ログイン済み(active)" : "ログイン済み",
          version: versionOf("gcloud", run),
        }),
      );
    else
      add({
        service: "Google Cloud",
        scope: project.code === 0 ? text(project.stdout) : "",
        source: "gcloud auth list",
        status: "判定不能",
        version: versionOf("gcloud", run),
      });
  }
  if (exists("npm")) {
    const r = run("npm", ["whoami"]);
    const parsed = parseNpmWhoami(r.stdout + "\n" + r.stderr, r.code);
    add({
      service: "npm",
      ...parsed,
      source: "npm whoami",
      version: versionOf("npm", run),
    });
  }
  // clasp は認証ファイルの存在と更新日時だけを見る。本文は認証情報そのものなので開かない。
  const claspPath = path.join(home, ".clasprc.json");
  if (exists("clasp") || fs.existsSync(claspPath)) {
    let scope = "";
    try {
      scope = "mtime " + fs.statSync(claspPath).mtime.toISOString();
    } catch {}
    add({
      service: "clasp",
      scope,
      source: "認証ファイルの存在/mtime",
      status: scope ? "ログイン済み(アカウント不明)" : "判定不能",
      version: exists("clasp") ? versionOf("clasp", run) : "",
    });
  }
  if (exists("supabase")) {
    const r = run("supabase", ["projects", "list"]);
    let supabaseStatus = "判定不能";
    if (!r.timedOut && r.code === 0) {
      supabaseStatus = "ログイン済み(アカウント不明)";
    }
    const count =
      r.code === 0
        ? String(r.stdout)
            .split(/\r?\n/)
            .filter((line) => /^\s*[|│]/.test(line)).length
        : "";
    add({
      service: "Supabase",
      scope: count !== "" ? `${count}件` : "",
      source: "supabase projects list",
      status: supabaseStatus,
      version: versionOf("supabase", run),
    });
  }
  const optional = [
    ["wrangler", "Cloudflare", ["whoami"]],
    [
      "aws",
      "AWS",
      ["sts", "get-caller-identity", "--query", "Arn", "--output", "text"],
    ],
    ["firebase", "Firebase", ["login:list"]],
    ["netlify", "Netlify", ["status"]],
    ["railway", "Railway", ["whoami"]],
    ["fly", "Fly", ["auth", "whoami"]],
    ["heroku", "Heroku", ["auth", "whoami"]],
    [
      "doctl",
      "DigitalOcean",
      ["account", "get", "--format", "Email", "--no-header"],
    ],
  ];
  for (const [command, service, args] of optional)
    if (exists(command)) {
      const r = run(command, args);
      let optionalStatus = "判定不能";
      if (!r.timedOut && r.code === 0) optionalStatus = "ログイン済み";
      add({
        service,
        account: r.code === 0 ? text(r.stdout).split(/\r?\n/).pop() : "",
        source: `${command} ${args.join(" ")}`,
        status: optionalStatus,
        version: versionOf(command, run),
      });
    }
  return rows;
}

if (isEntry(import.meta.url)) {
  const rows = await collectCloudInventory();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(rows, null, 2)
      : formatCloudTable(rows),
  );
}
