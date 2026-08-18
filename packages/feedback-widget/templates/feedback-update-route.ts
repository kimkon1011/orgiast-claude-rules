import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATUSES = new Set(["new", "triaged", "in_progress", "done", "rejected"]);
const PRIORITIES = new Set(["low", "normal", "high"]);

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const id = String(form.get("id") || "").trim();
  const status = String(form.get("status") || "new");
  const priority = String(form.get("priority") || "normal");
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!id || !url || !key || !STATUSES.has(status) || !PRIORITIES.has(priority)) return NextResponse.json({ ok: false, error: "更新内容または環境変数が不正です" }, { status: 400 });
  const response = await fetch(`${url}/rest/v1/app_feedback?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ status, priority, admin_note: String(form.get("admin_note") || "").trim() || null, resolved_ref: String(form.get("resolved_ref") || "").trim() || null, updated_at: new Date().toISOString() }) });
  if (!response.ok) return NextResponse.json({ ok: false, error: (await response.text()).slice(0, 500) }, { status: response.status });
  return NextResponse.redirect(new URL("/feedback", request.url), 303);
}
