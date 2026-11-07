export const dynamic = "force-dynamic";

type Row = { id: string; kind: string; title: string; body: string; page_path: string | null; submitter: string | null; submitter_email: string | null; status: string; priority: string; admin_note: string | null; resolved_ref: string | null; screenshot_path: string | null; created_at: string; screenshot_url?: string | null };
const statusLabels: Record<string, string> = { new: "未対応", triaged: "確認済み", in_progress: "対応中", done: "完了", rejected: "却下" };
const priorityLabels: Record<string, string> = { low: "低", normal: "通常", high: "高" };
const box = { border: "1px solid #d1d5db", borderRadius: 8, padding: 16, background: "white" };
const input = { boxSizing: "border-box" as const, width: "100%", border: "1px solid #d1d5db", borderRadius: 5, padding: 7, background: "white", color: "#111827" };

async function loadRows(url: string, key: string): Promise<Row[]> {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const response = await fetch(`${url}/rest/v1/app_feedback?select=*&order=created_at.desc`, { headers, cache: "no-store" });
  if (!response.ok) throw new Error((await response.text()).slice(0, 300));
  const rows = await response.json() as Row[];
  return Promise.all(rows.map(async (row) => {
    if (!row.screenshot_path) return row;
    try {
      const signed = await fetch(`${url}/storage/v1/object/sign/feedback-screenshots/${encodeURIComponent(row.screenshot_path)}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }), cache: "no-store" });
      const data = signed.ok ? await signed.json() : {};
      const path = data.signedURL || data.signedUrl;
      return { ...row, screenshot_url: path ? (path.startsWith("http") ? path : `${url}/storage/v1${path}`) : null };
    } catch { return row; }
  }));
}

function List({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p style={{ color: "#6b7280" }}>該当する提出はありません。</p>;
  return <div style={{ display: "grid", gap: 12 }}>{rows.map((row) => <article key={row.id} style={box}>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)", gap: 18 }}>
      <div><div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center", fontSize: 12 }}><b style={{ color: row.kind === "bug" ? "#be123c" : "#4338ca" }}>{row.kind === "bug" ? "不具合" : "要望"}</b><span>{statusLabels[row.status]}</span><span>優先度: {priorityLabels[row.priority]}</span><time>{new Date(row.created_at).toLocaleString("ja-JP")}</time></div>
      <h3 style={{ margin: "8px 0" }}>{row.title}</h3><p style={{ whiteSpace: "pre-wrap", padding: 10, borderRadius: 5, background: "#f3f4f6" }}>{row.body}</p>
      {row.screenshot_url && <a href={row.screenshot_url} target="_blank" rel="noreferrer"><img src={row.screenshot_url} alt="添付スクリーンショット" style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", border: "1px solid #ddd" }} /></a>}
      <p style={{ fontSize: 12, color: "#6b7280" }}>提出者: {row.submitter || row.submitter_email || "不明"}{row.page_path && <> ／ <a href={row.page_path}>提出元 {row.page_path}</a></>}</p>
      {row.admin_note && <p style={{ fontSize: 12 }}>対応メモ: {row.admin_note}</p>}{row.resolved_ref && <p style={{ fontSize: 12 }}>対応参照: {row.resolved_ref}</p>}</div>
      <form method="post" action="/api/feedback/update" style={{ ...box, background: "#f9fafb" }}><input type="hidden" name="id" value={row.id} />
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>ステータス<select name="status" defaultValue={row.status} style={input}><option value="new">未対応</option><option value="triaged">確認済み</option><option value="in_progress">対応中</option><option value="done">完了</option><option value="rejected">却下</option></select></label>
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>優先度<select name="priority" defaultValue={row.priority} style={input}><option value="low">低</option><option value="normal">通常</option><option value="high">高</option></select></label>
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>対応メモ<textarea name="admin_note" defaultValue={row.admin_note || ""} rows={3} style={input} /></label>
        <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>対応参照<input name="resolved_ref" defaultValue={row.resolved_ref || ""} placeholder="PR / commit / URL など" style={input} /></label>
        <button type="submit" style={{ ...input, border: 0, background: "#1d4ed8", color: "white", fontWeight: 700 }}>更新</button></form>
    </div></article>)}</div>;
}

export default async function FeedbackPage() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, ""); const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return <main style={{ maxWidth: 1100, margin: "40px auto", padding: 20 }}><h1>🐛 不具合・要望</h1><p style={box}>このアプリは Discord 通知のみのモードです。Supabase 環境変数を設定すると一覧を利用できます。</p></main>;
  try { const rows = await loadRows(url, key); const open = rows.filter((r) => ["new", "triaged", "in_progress"].includes(r.status)); const closed = rows.filter((r) => ["done", "rejected"].includes(r.status));
    return <main style={{ maxWidth: 1100, margin: "30px auto", padding: 20, color: "#111827" }}><h1>🐛 不具合・要望</h1><p>社員からの提出を確認し、ステータスと対応内容を更新します。</p><section><h2>未対応・対応中 ({open.length})</h2><List rows={open} /></section><section style={{ marginTop: 28 }}><h2>完了・却下 ({closed.length})</h2><List rows={closed} /></section></main>;
  } catch (error) { return <main style={{ maxWidth: 1100, margin: "40px auto", padding: 20 }}><h1>🐛 不具合・要望</h1><p style={box}>一覧を取得できませんでした。テーブルと環境変数を確認してください。{error instanceof Error ? ` (${error.message})` : ""}</p></main>; }
}
