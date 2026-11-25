// 静的な再発防止ガード。
// 2026-10-10 の実害: tools/messenger-watch.mjs の --login が Facebook の 2 段階認証(checkpoint)の
// 途中 URL を「ログイン済み」と誤判定してツール側からブラウザを閉じ、kim にログインを 3 回やらせた。
// tools/gpage-fetch.mjs の --login も同じ型(URL ヒューリスティックで自動 return → finally で close)。
// 人がログインする可視ブラウザは tools/lib/human-login.mjs の runHumanLogin に一本化する。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

export const REASON =
  "人がログインする可視ブラウザ(headless: false)は tools/lib/human-login.mjs の runHumanLogin 経由にすること。" +
  "2026-10-10 実害: URL ヒューリスティックで 2 段階認証の途中をログイン済みと誤判定し、ツール側がブラウザを閉じて kim にログインを 3 回やらせた" +
  "(同梱 Chromium と playwright-core の revision ずれでも落ちた)。runHumanLogin は正規版 Chrome を優先し、人が閉じるまで絶対に close しない。";

const HEADLESS_FALSE = /headless\s*:\s*false/g;
// 可視ブラウザの起動呼び出し。headless: false がこの呼び出しの中にある場合だけ違反にする
// (usage-stats.mjs のように「headless」と名の付いた無関係な真偽値を持つファイルを誤検知しないため)。
const LAUNCH_CALL = /(?:launchPersistentContext|\.launch)\s*\(/;
const IMPORTS_RUN_HUMAN_LOGIN = /import\s*\{[^}]*\brunHumanLogin\b[^}]*\}\s*from\s*["'][^"']*human-login\.mjs["']/;
const CONTEXT_BEFORE = 800;
const CONTEXT_AFTER = 300;

function mjsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return mjsFiles(target);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [target] : [];
  });
}

export function usesVisibleBrowserLaunch(source) {
  for (const match of source.matchAll(HEADLESS_FALSE)) {
    const window = source.slice(Math.max(0, match.index - CONTEXT_BEFORE), match.index + CONTEXT_AFTER);
    if (LAUNCH_CALL.test(window)) return true;
  }
  return false;
}

// root 配下で「可視ブラウザを直接起動しているのに runHumanLogin を使っていない」ファイルを返す。
export function findHumanLoginViolations(root) {
  const violations = [];
  for (const file of mjsFiles(root)) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (relative.endsWith(".test.mjs")) continue;
    if (relative === "lib/human-login.mjs") continue;
    const source = fs.readFileSync(file, "utf8");
    if (!usesVisibleBrowserLaunch(source)) continue;
    if (IMPORTS_RUN_HUMAN_LOGIN.test(source)) continue;
    violations.push(relative);
  }
  return violations.sort();
}

test("可視ブラウザを起動するツールは必ず runHumanLogin を使う", () => {
  const violations = findHumanLoginViolations(toolsDir);
  assert.deepEqual(
    violations,
    [],
    `headless: false でブラウザを直接起動しているのに runHumanLogin を使っていないファイル:\n${violations.join("\n")}\n${REASON}`,
  );
});

test("違反検出: 直接起動は違反、runHumanLogin 経由・無関係な headless は違反でない", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "human-login-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "direct-launch.mjs"),
    ['import { chromium } from "playwright-core";', 'await chromium.launchPersistentContext(dir, { headless: false });'].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "via-helper.mjs"),
    ['import { runHumanLogin } from "./lib/human-login.mjs";', "export const x = 1;"].join("\n"),
  );
  // 可視ブラウザを起動するが runHumanLogin を使っているので違反ではない
  fs.writeFileSync(
    path.join(root, "helper-user.mjs"),
    ['import { runHumanLogin } from "./lib/human-login.mjs";', "await runHumanLogin({ chromium, profileDir, url });"].join("\n"),
  );
  // 起動呼び出しの外にある無関係な headless: false は違反ではない
  fs.writeFileSync(path.join(root, "classify.mjs"), "export function f() {\n  return { headless: false, job: null };\n}\n");
  // ガード対象外
  fs.writeFileSync(path.join(root, "noise.test.mjs"), "const opts = { headless: false };\n");

  assert.deepEqual(findHumanLoginViolations(root), ["direct-launch.mjs"]);
});
