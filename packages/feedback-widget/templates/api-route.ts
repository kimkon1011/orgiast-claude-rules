import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_NAME = "{{APP_NAME}}";
// 社員チャンネル。非秘匿 ID であり、環境変数で上書きできます。
const DEFAULT_CHANNEL_ID = "{{DISCORD_CHANNEL_ID}}";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function supabaseHeaders(extra: Record<string, string> = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function responseText(response: Response) {
  return (await response.text().catch(() => "")).slice(0, 500);
}

function accessToken(request: NextRequest): string | null {
  const values: string[] = [];
  const chunks = new Map<string, Array<{ index: number; value: string }>>();
  for (const cookie of request.cookies.getAll()) {
    if (!cookie.name.startsWith("sb-") || !cookie.name.includes("-auth-token")) continue;
    const match = cookie.name.match(/^(.*-auth-token)\.(\d+)$/);
    if (!match) { values.push(cookie.value); continue; }
    const group = chunks.get(match[1]) || [];
    group.push({ index: Number(match[2]), value: cookie.value });
    chunks.set(match[1], group);
  }
  for (const group of chunks.values()) {
    values.push(group.sort((a, b) => a.index - b.index).map((chunk) => chunk.value).join(""));
  }
  for (const rawValue of values) {
    try {
      let value = decodeURIComponent(rawValue);
      if (value.startsWith("base64-")) value = Buffer.from(value.slice(7), "base64").toString("utf8");
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
      if (typeof parsed?.access_token === "string") return parsed.access_token;
    } catch { /* 認証情報の取得は best-effort */ }
  }
  return null;
}

async function authEmail(request: NextRequest, url: string): Promise<string | null> {
  const token = accessToken(request);
  if (!token) return null;
  try {
    const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user.email === "string" ? user.email : null;
  } catch { return null; }
}

async function uploadImage(url: string, file: File): Promise<string | null> {
  if (!file.size || file.size > MAX_IMAGE_BYTES || !file.type.startsWith("image/")) return null;
  try {
    const extension = (file.name.split(".").pop() || file.type.split("/")[1] || "png").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "png";
    const path = `${crypto.randomUUID()}.${extension}`;
    const response = await fetch(`${url}/storage/v1/object/feedback-screenshots/${path}`, { method: "POST", headers: supabaseHeaders({ "Content-Type": file.type, "x-upsert": "false" }), body: Buffer.from(await file.arrayBuffer()) });
    return response.ok ? path : null;
  } catch { return null; }
}

async function signedUrl(url: string, path: string, expiresIn: number): Promise<string | null> {
  try {
    const response = await fetch(`${url}/storage/v1/object/sign/feedback-screenshots/${encodeURIComponent(path)}`, { method: "POST", headers: supabaseHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn }) });
    if (!response.ok) return null;
    const data = await response.json();
    const signed = data.signedURL || data.signedUrl;
    return signed ? (signed.startsWith("http") ? signed : `${url}/storage/v1${signed}`) : null;
  } catch { return null; }
}

async function notifyDiscord(content: string): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channel = process.env.DISCORD_FEEDBACK_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  const webhook = process.env.FEEDBACK_DISCORD_WEBHOOK_URL;
  try {
    const response = token && channel
      ? await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) })
      : webhook ? await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }) : null;
    return response?.ok === true;
  } catch { return false; }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const kind = String(form.get("kind") || "bug") === "request" ? "request" : "bug";
    const title = String(form.get("title") || "").trim();
    const body = String(form.get("body") || "").trim();
    const pagePath = String(form.get("page_path") || "").trim() || null;
    if (!title || !body) return NextResponse.json({ ok: false, error: "タイトルと内容は必須です" }, { status: 400 });

    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
    const hasDb = Boolean(url && process.env.SUPABASE_SERVICE_ROLE_KEY);
    const clientSubmitter = String(form.get("submitter") || "").trim() || null;
    const email = hasDb ? await authEmail(request, url) : null;
    const submitter = email || clientSubmitter;
    const screenshot = form.get("screenshot");
    const screenshotPath = hasDb && screenshot instanceof File ? await uploadImage(url, screenshot) : null;
    let id: string | null = null;
    let db = false;
    if (hasDb) {
      try {
        const response = await fetch(`${url}/rest/v1/app_feedback`, { method: "POST", headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }), body: JSON.stringify({ kind, title, body, page_path: pagePath, submitter, submitter_email: email, screenshot_path: screenshotPath }) });
        if (response.ok) { const rows = await response.json(); id = rows?.[0]?.id || null; db = true; }
        else console.error("feedback DB insert failed:", await responseText(response));
      } catch (error) { console.error("feedback DB insert failed:", error); }
    }
    const screenshotLink = screenshotPath ? await signedUrl(url, screenshotPath, 60 * 60 * 24 * 7) : null;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const content = [`🐛 **[${APP_NAME}] ${kind === "bug" ? "不具合" : "要望"}: ${title}**`, body.slice(0, 300), `提出者: ${submitter || "不明"}`, `画面: ${pagePath || "不明"}`, `管理画面: ${baseUrl}/feedback`, screenshotLink ? `📎 スクショ: ${screenshotLink}` : null].filter(Boolean).join("\n");
    const discord = await notifyDiscord(content);
    if (!db && !discord) return NextResponse.json({ ok: false, error: hasDb ? "DB保存とDiscord通知の両方に失敗しました" : "保存先が未設定です。SupabaseまたはDiscordを設定してください" }, { status: 503 });
    return NextResponse.json({ ok: true, id, sinks: { db, discord }, note: !db ? "記録は Discord のみ" : undefined });
  } catch (cause) {
    return NextResponse.json({ ok: false, error: cause instanceof Error ? cause.message : "投稿処理に失敗しました" }, { status: 500 });
  }
}
