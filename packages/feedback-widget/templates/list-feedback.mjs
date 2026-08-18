import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

for (const name of [".env.local", ".env"]) {
  const file = resolve(process.cwd(), name); if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2"); }
}
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, ""); const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const query = "select=id,kind,priority,status,title,body,page_path,submitter,created_at&status=in.(new,triaged,in_progress)&order=created_at.asc";
const response = await fetch(`${url}/rest/v1/app_feedback?${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!response.ok) throw new Error(`取得失敗 (${response.status}): ${(await response.text()).slice(0, 500)}`);
console.log(JSON.stringify(await response.json(), null, 2));
