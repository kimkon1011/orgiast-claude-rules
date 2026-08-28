import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_NAME = "{{APP_NAME}}";
// 社員チャンネル。非秘匿 ID であり、環境変数で上書きできます。
const DEFAULT_CHANNEL_ID = "{{DISCORD_CHANNEL_ID}}";
// 管理画面 /feedback を入れなかった構成では、通知に存在しないリンクを出さない。
const ADMIN_PAGE = {{ADMIN_PAGE}};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_BODY = 4000;

// 公開サイト(未認証で誰でも POST できる)向けの最低限の濫用対策。
// サーバーレスでは実行インスタンスごとの計数になるため完全な制限にはならない。
// 「無いよりは遥かに良い」レベルの防御であり、厳密に止めたい場合は前段(Cloudflare 等)を併用する。
const hits = new Map<string, number[]>();

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  // noUncheckedIndexedAccess を有効にしたリポでも通るよう、添字アクセスは undefined を潰しておく。
  if (forwarded) return (forwarded.split(",")[0] || "").trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function rateLimited(request: NextRequest): boolean {
  const limit = Number(process.env.FEEDBACK_RATE_LIMIT || 5);
  const windowMs = Number(process.env.FEEDBACK_RATE_WINDOW_MIN || 10) * 60 * 1000;
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const now = Date.now();
  const key = clientIp(request);
  const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  // Map が無限に育たないよう、ウィンドウ外だけになったキーを掃除する。
  if (hits.size > 500) for (const [other, times] of hits) { if (!times.some((at) => now - at < windowMs)) hits.delete(other); }
  return false;
}


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
    const name = match[1] as string;
    const group = chunks.get(name) || [];
    group.push({ index: Number(match[2]), value: cookie.value });
    chunks.set(name, group);
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

async function notifyDiscord(content: string, image: { name: string; type: string; data: Buffer } | null): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channel = process.env.DISCORD_FEEDBACK_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  const webhook = process.env.FEEDBACK_DISCORD_WEBHOOK_URL;
  const endpoint = token && channel ? `https://discord.com/api/v10/channels/${channel}/messages` : webhook || "";
  if (!endpoint) return false;
  const headers: Record<string, string> = token && channel ? { Authorization: `Bot ${token}` } : {};
  // 提出元 URL のプレビューで通知チャンネルが流れないよう、埋め込み表示を抑止する。
  const payload = { content, allowed_mentions: { parse: [] as string[] }, flags: 4 };
  try {
    // 画像は Discord へ直接添付する。DB を使わない構成でもスクショが失われないようにするため
    // (以前は Supabase 未設定時にフォームの添付が黙って捨てられていた)。
    if (image) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify(payload));
      form.set("files[0]", new File([new Uint8Array(image.data)], image.name || "screenshot.png", { type: image.type || "image/png" }));
      const response = await fetch(endpoint, { method: "POST", headers, body: form });
      if (response.ok) return true;
      // 添付付きが弾かれた場合は本文だけでも通知する。
    }
    const response = await fetch(endpoint, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return response.ok;
  } catch { return false; }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const kind = String(form.get("kind") || "bug") === "request" ? "request" : "bug";
    const title = String(form.get("title") || "").trim().slice(0, MAX_TITLE);
    const body = String(form.get("body") || "").trim().slice(0, MAX_BODY);
    const pagePath = String(form.get("page_path") || "").trim() || null;
    // ハニーポット: 人間には見えない欄。埋まっていれば bot なので、気付かせないよう成功を装って捨てる。
    if (String(form.get("company") || "").trim()) return NextResponse.json({ ok: true, id: null, sinks: { db: false, discord: false } });
    if (!title || !body) return NextResponse.json({ ok: false, error: "タイトルと内容は必須です" }, { status: 400 });
    if (rateLimited(request)) return NextResponse.json({ ok: false, error: "送信が続いています。しばらく待ってから再度お試しください" }, { status: 429 });

    const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
    const hasDb = Boolean(url && process.env.SUPABASE_SERVICE_ROLE_KEY);
    const clientSubmitter = String(form.get("submitter") || "").trim() || null;
    const email = hasDb ? await authEmail(request, url) : null;
    const submitter = email || clientSubmitter;
    const screenshot = form.get("screenshot");
    const upload = screenshot instanceof File && screenshot.size > 0 && screenshot.size <= MAX_IMAGE_BYTES && screenshot.type.startsWith("image/") ? screenshot : null;
    const screenshotPath = hasDb && upload ? await uploadImage(url, upload) : null;
    // DB へ入れられない構成でも Discord に添付するため、バイト列を保持する。
    const attachment = upload && !screenshotPath ? { name: upload.name, type: upload.type, data: Buffer.from(await upload.arrayBuffer()) } : null;
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
    const content = [`🐛 **[${APP_NAME}] ${kind === "bug" ? "不具合" : "要望"}: ${title}**`, body.slice(0, 300), `提出者: ${submitter || "不明"}`, `画面: ${pagePath || "不明"}`, ADMIN_PAGE ? `管理画面: ${baseUrl}/feedback` : `提出元: ${baseUrl}${pagePath || "/"}`, screenshotLink ? `📎 スクショ: ${screenshotLink}` : null].filter(Boolean).join("\n");
    const discord = await notifyDiscord(content, attachment);
    if (!db && !discord) return NextResponse.json({ ok: false, error: hasDb ? "DB保存とDiscord通知の両方に失敗しました" : "保存先が未設定です。SupabaseまたはDiscordを設定してください" }, { status: 503 });
    return NextResponse.json({ ok: true, id, sinks: { db, discord }, note: !db ? "記録は Discord のみ" : undefined });
  } catch (cause) {
    return NextResponse.json({ ok: false, error: cause instanceof Error ? cause.message : "投稿処理に失敗しました" }, { status: 500 });
  }
}
