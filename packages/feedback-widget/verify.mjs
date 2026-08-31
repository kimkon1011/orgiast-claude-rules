#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2); const at = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const base = (at("--url") || "").replace(/\/$/, ""); const target = resolve(at("--target") || process.cwd()); const keep = args.includes("--keep");
if (!base) { console.error("❌ --url https://<app>.vercel.app を指定してください"); process.exit(1); }
const env = { ...process.env };
for (const name of [".env", ".env.local"]) { const file = join(target, name); if (!existsSync(file)) continue; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/); if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2"); } }
const stamp = new Date().toISOString(); const form = new FormData(); form.set("kind", "request"); form.set("title", "[install-verify] 動作確認"); form.set("body", `自動インストール検証 ${stamp}`); form.set("page_path", "/install-verify");
let data; try { const response = await fetch(`${base}/api/feedback`, { method: "POST", body: form }); data = await response.json().catch(() => ({})); if (!response.ok || !data.ok) throw new Error(`${response.status}: ${data.error || "応答が不正です"}`); console.log("✅ API 投稿成功"); console.log(`   sinks: DB=${Boolean(data.sinks?.db)} Discord=${Boolean(data.sinks?.discord)} id=${data.id || "なし"}`); } catch (error) { console.error(`❌ API 投稿失敗: ${error.message}`); console.error("   原因候補: route 未デプロイ / 環境変数未設定 / app_feedback テーブル未作成 / 認証エラー(401)"); process.exit(1); }
const url = (env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, ""); const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log("⚠️ service role がローカルに無いため read-back はスキップ（API 投稿は成功）"); process.exit(0); }
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
try {
  const filter = data.id ? `id=eq.${encodeURIComponent(data.id)}` : `title=eq.${encodeURIComponent("[install-verify] 動作確認")}&order=created_at.desc&limit=1`;
  const response = await fetch(`${url}/rest/v1/app_feedback?select=id,status,admin_note&${filter}`, { headers }); const rows = response.ok ? await response.json() : [];
  if (!response.ok || !rows.length) throw new Error(`${response.status}: テスト行がありません`); console.log(`✅ read-back 成功: ${rows[0].id}`);
  if (keep) console.log("✅ --keep のためテスト行を更新せず保持"); else { const updated = await fetch(`${url}/rest/v1/app_feedback?id=eq.${encodeURIComponent(rows[0].id)}`, { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ status: "rejected", admin_note: "install-verify (自動テスト投稿)", updated_at: new Date().toISOString() }) }); if (!updated.ok) throw new Error(`後処理失敗 (${updated.status})`); console.log("✅ テスト行を却下済みに更新（削除はしていません）"); }
} catch (error) { console.error(`❌ read-back 検証失敗: ${error.message}`); console.error("   原因候補: テーブル未作成 / URL・service role 不一致 / RLS・401"); process.exit(1); }
