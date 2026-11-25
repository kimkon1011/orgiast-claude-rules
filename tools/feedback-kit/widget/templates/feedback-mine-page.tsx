import { cookies } from "next/headers";

export const dynamic = "force-dynamic";
type Row = { id: string; kind: string; title: string; body: string; status: string; created_at: string };
const statusLabels: Record<string, string> = { new: "未対応", triaged: "確認済み", in_progress: "対応中", done: "完了", rejected: "却下" };

function accessToken(request: { cookies: { getAll(): Array<{ name: string; value: string }> } }): string | null {
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

async function authEmail(request: { cookies: { getAll(): Array<{ name: string; value: string }> } }, url: string): Promise<string | null> {
  const token = accessToken(request);
  if (!token) return null;
  try {
    const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user.email === "string" ? user.email : null;
  } catch { return null; }
}

export default async function FeedbackMinePage() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  let message = "";
  let rows: Row[] = [];
  if (!url || !key) message = "このアプリは通知のみのモードです。過去の投稿と対応状況は担当者にお問い合わせください。";
  else {
    const email = await authEmail({ cookies: await cookies() }, url);
    if (!email) message = "投稿時と同じアカウントでログインしてください。ログインせず送信した投稿は担当者にお問い合わせください。";
    else {
      try {
        // Auth APIで検証したメールだけで絞る。編集用の列・連絡先・画像URLは取得しない。
        const query = new URLSearchParams({ select: "id,kind,title,body,status,created_at", submitter_email: `eq.${JSON.stringify(email)}`, order: "created_at.desc" });
        const response = await fetch(`${url}/rest/v1/app_feedback?${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
        if (!response.ok) throw new Error("history unavailable");
        rows = await response.json() as Row[];
        if (!rows.length) message = "送信した投稿はありません。";
      } catch { message = "一覧を取得できませんでした。時間をおいて再度お試しください。"; }
    }
  }
  return <main style={{ maxWidth: 800, margin: "30px auto", padding: 20 }}>
    <h1>送信した内容・対応状況</h1>
    {message && <p role="status">{message}</p>}
    {rows.map(row => <article key={row.id} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <p>{row.kind === "request" ? "要望" : "不具合"} ／ {statusLabels[row.status] || "未対応"} ／ <time>{new Date(row.created_at).toLocaleString("ja-JP")}</time></p>
      <h2>{row.title}</h2>
      <p style={{ whiteSpace: "pre-wrap" }}>{row.body.split("\n画像:\n")[0]}</p>
    </article>)}
  </main>;
}
