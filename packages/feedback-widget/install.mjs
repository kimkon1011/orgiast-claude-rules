#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RAW = "https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/templates";
const TEMPLATE_NAMES = ["api-route.ts", "FeedbackWidget.tsx", "FeedbackTriggerButton.tsx", "feedback-admin-page.tsx", "feedback-update-route.ts", "list-feedback.mjs", "migration_app_feedback.sql"];
const args = process.argv.slice(2); const options = { target: process.cwd(), appName: "", channel: "", webhook: "", admin: true, dryRun: false, force: false };
function value(name) { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) return ""; return args[index + 1]; }
options.target = resolve(value("--target") || options.target); options.appName = value("--app-name"); options.channel = value("--discord-channel") || options.channel; options.webhook = value("--webhook");
options.admin = !args.includes("--no-admin-page"); options.dryRun = args.includes("--dry-run"); options.force = args.includes("--force");
const known = new Set(["--target", "--app-name", "--discord-channel", "--webhook", "--no-admin-page", "--dry-run", "--force"]);
for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`不明なオプション: ${args[i]}`); if (["--target", "--app-name", "--discord-channel", "--webhook"].includes(args[i])) i++; }

const packageFile = join(options.target, "package.json");
if (!existsSync(packageFile)) throw new Error(`package.json がありません: ${packageFile}`);
const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
if (!pkg.dependencies?.next && !pkg.devDependencies?.next) throw new Error("Next.js が package.json に見つかりません。App Router 対応の Next.js リポジトリを指定してください。");
options.appName ||= String(pkg.name || "アプリ").replace(/[-_]+/g, " ");
const appRoot = existsSync(join(options.target, "src", "app")) ? join(options.target, "src", "app") : join(options.target, "app");
if (!existsSync(appRoot)) throw new Error("App Router の src/app または app が見つかりません。");
const srcStyle = appRoot.includes(`${sep}src${sep}`); const componentRoot = existsSync(join(options.target, "src", "components")) ? join(options.target, "src", "components") : existsSync(join(options.target, "components")) ? join(options.target, "components") : join(options.target, srcStyle ? "src/components" : "components");
const ts = existsSync(join(options.target, "tsconfig.json")) || ["layout.tsx", "page.tsx"].some((name) => existsSync(join(appRoot, name)));
let alias = false;
// paths の検出はテキスト照合で行う。JSON コメント除去の正規表現は tsconfig の "**/*.ts"(include) を
// ブロックコメント終端 */ と誤認して JSON を壊すため使わない(Next.js 既定の tsconfig で実際に誤検出した)。
for (const name of ["tsconfig.json", "jsconfig.json"]) { try { const raw = readFileSync(join(options.target, name), "utf8"); if (/"@\/\*"\s*:/.test(raw)) alias = true; } catch {} }
function envFiles() { const result = { ...process.env }; for (const name of [".env", ".env.local"]) { const path = join(options.target, name); if (!existsSync(path)) continue; for (const line of readFileSync(path, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/); if (match) result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2"); } } return result; }
// チャンネル ID は公開リポジトリに書かず、--discord-channel か対象アプリの env から取る。
const env = envFiles();
options.channel ||= String(env.DISCORD_FEEDBACK_CHANNEL_ID || "");
const changed = []; const skipped = []; const pending = [];
function log(line = "") { console.log(line); }
function put(path, content, updateExisting = false) { const rel = relative(options.target, path); if (existsSync(path) && !options.force && !updateExisting) { skipped.push(rel); return; } changed.push(rel); if (!options.dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content.replace(/\r\n/g, "\n"), "utf8"); } }
async function template(name) { const local = join(dirname(fileURLToPath(import.meta.url)), "templates", name); if (existsSync(local)) return readFileSync(local, "utf8"); const response = await fetch(`${RAW}/${name}?cb=${Date.now()}`); if (!response.ok) throw new Error(`テンプレート取得失敗: ${name} (${response.status})`); return response.text(); }
function tokens(text) { return text.replaceAll("{{APP_NAME}}", options.appName.replaceAll('"', '\\"')).replaceAll("{{DISCORD_CHANNEL_ID}}", options.channel).replaceAll("{{IMPORT_PREFIX}}", alias ? "@" : "relative"); }
function javascript(text, name) {
  if (name === "FeedbackTriggerButton.tsx") return text.replace(/import type .*\n\n/, "").replace(/type Props =.*\n\n/, "").replace(/\(\{ children = "🐛 不具合・要望", onClick, \.\.\.props \}: Props\)/, '({ children = "🐛 不具合・要望", onClick, ...props })');
  if (name === "FeedbackWidget.tsx") return text.replace(/, type CSSProperties, type FormEvent/, "").replace(/type Props =.*\n/, "").replace(/: CSSProperties/g, "").replace(/: Props\)/, ")").replace(/event: FormEvent<HTMLFormElement>/, "event").replace(/event: KeyboardEvent/, "event");
  if (name === "api-route.ts") return text.replace(', type NextRequest', '').replace(/: NextRequest/g, '').replace(/: Record<string, string>/g, '').replace(/new Map<string, Array<\{ index: number; value: string \}>>\(\)/g, 'new Map()').replace(/: string\[\]/g, '').replace(/: Promise<string \| null>/g, '').replace(/: string \| null/g, '').replace(/: string/g, '').replace(/: number/g, '');
  if (name === "feedback-update-route.ts") return text.replace(', type NextRequest', '').replace(/: NextRequest/g, '');
  if (name === "feedback-admin-page.tsx") return text.replace(/type Row = .*\n/, '').replace(/: Record<string, string>/g, '').replace(/ as const/g, '').replace(/: Promise<Row\[]>/g, '').replace(/ as Row\[]/g, '').replace(/\(\{ rows \}: \{ rows: Row\[] \}\)/g, '({ rows })');
  return text;
}

const destinations = [
  ["api-route.ts", join(appRoot, `api/feedback/route.${ts ? "ts" : "js"}`)], ["FeedbackWidget.tsx", join(componentRoot, ts ? "FeedbackWidget.tsx" : "FeedbackWidget.jsx")], ["FeedbackTriggerButton.tsx", join(componentRoot, ts ? "FeedbackTriggerButton.tsx" : "FeedbackTriggerButton.jsx")], ["list-feedback.mjs", join(options.target, "scripts/list-feedback.mjs")],
  ...(options.admin ? [["feedback-admin-page.tsx", join(appRoot, `feedback/page.${ts ? "tsx" : "jsx"}`)], ["feedback-update-route.ts", join(appRoot, `api/feedback/update/route.${ts ? "ts" : "js"}`)]] : []),
];
for (const [name, path] of destinations) { let content = tokens(await template(name)); if (!ts && (name.endsWith(".tsx") || name.endsWith(".ts"))) content = javascript(content, name); put(path, content); }

function walkLayouts(dir, depth = 0) { if (depth > 5 || !existsSync(dir)) return []; const result = []; for (const item of readdirSync(dir, { withFileTypes: true })) { if (item.name.startsWith(".") || ["node_modules", "api"].includes(item.name)) continue; const path = join(dir, item.name); if (item.isDirectory()) result.push(...walkLayouts(path, depth + 1)); else if (/^layout\.(tsx|jsx)$/.test(item.name)) result.push(path); } return result; }
function addImport(source, importLine) {
  if (source.includes(importLine)) return source;
  const importPattern = /^[ \t]*import(?:[\s\S]*?\bfrom[ \t]*)?["'][^"'\n]+["'][ \t]*;?[ \t]*(?:\r?\n|$)/gm;
  const imports = [...source.matchAll(importPattern)];
  if (imports.length) { const last = imports.at(-1); const offset = last.index + last[0].length; return `${source.slice(0, offset)}${importLine}\n${source.slice(offset)}`; }
  const preamble = source.match(/^(?:(?:[ \t]*\/\*[\s\S]*?\*\/[ \t]*|[ \t]*\/\/[^\r\n]*|[ \t]*["']use (?:client|server)["'][ \t]*;?)[ \t]*(?:\r?\n|$)|\s*\r?\n)*/)?.[0] || "";
  return `${source.slice(0, preamble.length)}${importLine}\n${source.slice(preamble.length)}`;
}
const layouts = walkLayouts(appRoot).filter((path) => readFileSync(path, "utf8").includes("children"));
const grouped = layouts.filter((path) => relative(appRoot, path).includes("(")); const layout = grouped.sort((a, b) => b.split(sep).length - a.split(sep).length)[0] || layouts.find((path) => dirname(path) === appRoot);
if (layout) {
  const source = readFileSync(layout, "utf8");
  if (!source.includes("<FeedbackWidget")) {
    const componentFile = join(componentRoot, ts ? "FeedbackWidget" : "FeedbackWidget"); let spec = "@/components/FeedbackWidget"; if (!alias) { spec = relative(dirname(layout), componentFile).split(sep).join("/"); if (!spec.startsWith(".")) spec = `./${spec}`; }
    const importLine = `import { FeedbackWidget } from "${spec}";`;
    let next = addImport(source, importLine); const bodyAt = next.lastIndexOf("</body>");
    if (bodyAt >= 0) next = `${next.slice(0, bodyAt)}  <FeedbackWidget />\n${next.slice(bodyAt)}`;
    else { const returnClose = next.lastIndexOf(");"); if (returnClose >= 0) next = `${next.slice(0, returnClose)}  <FeedbackWidget />\n${next.slice(returnClose)}`; else next = ""; }
    if (next) put(layout, next, true); else pending.push(`レイアウト注入: ${layout} の children と同じ領域に <FeedbackWidget /> を追加し、先頭に ${importLine} を追加`);
  }
} else pending.push(`レイアウト注入: ${appRoot} 配下の layout に <FeedbackWidget /> を追加してください`);

const migrationDir = join(options.target, "supabase/migrations"); const existing = existsSync(migrationDir) ? readdirSync(migrationDir) : [];
const numbers = existing.map((name) => Number(name.match(/^(\d+)/)?.[1])).filter(Number.isFinite); const width = Math.max(4, ...existing.map((name) => name.match(/^(\d+)/)?.[1].length || 0)); const nextNumber = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(width, "0");
const migrationFile = join(migrationDir, `${nextNumber}_app_feedback.sql`); const migrationSql = tokens(await template("migration_app_feedback.sql")); put(migrationFile, migrationSql);

function commandExists(command) { try { execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }); return true; } catch { return false; } }
let migrationApplied = false;
if (!options.dryRun && changed.includes(relative(options.target, migrationFile))) { try { if (commandExists("supabase") && existsSync(join(options.target, "supabase/config.toml"))) { execFileSync("supabase", ["db", "push"], { cwd: options.target, stdio: "inherit" }); migrationApplied = true; } else { const dbUrl = env.DATABASE_URL || env.POSTGRES_URL_NON_POOLING || env.POSTGRES_URL; if (dbUrl && commandExists("psql")) { execFileSync("psql", [dbUrl, "-f", migrationFile], { cwd: options.target, stdio: "inherit" }); migrationApplied = true; } } } catch (error) { pending.push(`マイグレーション自動適用失敗: ${error.message}`); } }
if (!migrationApplied) { const match = String(env.NEXT_PUBLIC_SUPABASE_URL || "").match(/^https:\/\/([^.]+)\.supabase\.co/); const link = match ? `https://supabase.com/dashboard/project/${match[1]}/sql/new` : "Supabase Dashboard の SQL Editor"; pending.push(`マイグレーション: ${link} を開き ${migrationFile} の SQL 全文を貼って Run。完了判定 = Success. No rows returned\n\n${migrationSql}`); }
if (options.webhook && !env.FEEDBACK_DISCORD_WEBHOOK_URL) pending.push(`FEEDBACK_DISCORD_WEBHOOK_URL=${options.webhook} を .env.local と本番環境へ設定`);

log(`\n${options.dryRun ? "[dry-run] 予定内容" : "インストール結果"}`); log("変更ファイル:"); for (const file of changed) log(`- [x] ${file}`); if (!changed.length) log("- なし");
if (skipped.length) { log("上書きせずスキップ:"); for (const file of skipped) log(`- ${file}（--force で上書き）`); }
log("環境変数:");
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_APP_URL"]) log(env[name] ? `- ✅ ${name}: OK` : `- ⚠️ ${name}: 未設定。Vercel: vercel env add ${name} production`);
log(env.DISCORD_BOT_TOKEN || env.FEEDBACK_DISCORD_WEBHOOK_URL || options.webhook ? "- ✅ Discord 通知経路: OK" : "- ⚠️ Discord: DISCORD_BOT_TOKEN または FEEDBACK_DISCORD_WEBHOOK_URL を設定。Vercel: vercel env add DISCORD_BOT_TOKEN production");
log("残作業:"); if (pending.length) pending.forEach((item) => log(`- [ ] ${item}`)); else log("- [x] なし");
const verifyFile = join(dirname(fileURLToPath(import.meta.url)), "verify.mjs");
const verifyCommand = existsSync(verifyFile)
  ? `node ${verifyFile} --url <本番URL> --target ${options.target}`
  : `node -e "fetch('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/verify.mjs?cb='+Date.now()).then(r=>r.text()).then(t=>require('fs').writeFileSync('verify-feedback.mjs',t))" && node verify-feedback.mjs --url <本番URL>`;
log(`検証: ${verifyCommand}`);
