"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { usePathname } from "next/navigation";

type Props = { appName?: string; hideFloatingButton?: boolean; endpoint?: string };
const z = 2147483000;
const field: CSSProperties = { boxSizing: "border-box", width: "100%", marginTop: 5, border: "1px solid #d1d5db", borderRadius: 7, padding: "9px 10px", background: "#fff", color: "#111827", font: "inherit" };
const label: CSSProperties = { display: "block", marginTop: 12, color: "#374151", fontSize: 13, fontWeight: 600 };

export function FeedbackWidget({ appName = "{{APP_NAME}}", hideFloatingButton = false, endpoint = "/api/feedback" }: Props) {
  const routePath = usePathname();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(false);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const path = routePath || (typeof window !== "undefined" ? window.location.pathname : "");

  useEffect(() => {
    const show = () => { setError(""); setOpen(true); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("open-feedback", show);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("open-feedback", show); window.removeEventListener("keydown", key); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSending(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", body: new FormData(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `送信に失敗しました (${response.status})`);
      form.reset(); setFileName(""); setOpen(false); setToast(true);
      window.setTimeout(() => setToast(false), 3000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "送信に失敗しました"); }
    finally { setSending(false); }
  }

  return <>
    {open && <div onPaste={(event) => {
      const item = Array.from(event.clipboardData.items).find((value) => value.kind === "file" && value.type.startsWith("image/"));
      const image = item?.getAsFile();
      if (!image || !fileRef.current) return;
      const transfer = new DataTransfer(); transfer.items.add(image); fileRef.current.files = transfer.files;
      setFileName(image.name || "貼り付け画像.png"); event.preventDefault();
    }} style={{ position: "fixed", inset: 0, zIndex: z, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,.55)" }}>
      <button type="button" aria-label="フォームを閉じる" onClick={() => setOpen(false)} style={{ position: "absolute", inset: 0, border: 0, background: "transparent" }} />
      <div role="dialog" aria-modal="true" aria-labelledby="feedback-title" style={{ position: "relative", boxSizing: "border-box", width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", borderRadius: 12, padding: 22, background: "white", color: "#111827", boxShadow: "0 20px 50px rgba(0,0,0,.3)" }}>
        <button type="button" aria-label="フォームを閉じる" onClick={() => setOpen(false)} style={{ position: "absolute", top: 12, right: 14, border: 0, background: "transparent", fontSize: 24, cursor: "pointer" }}>×</button>
        <h2 id="feedback-title" style={{ margin: "0 32px 4px 0", fontSize: 19 }}>{appName} 不具合・要望</h2>
        <form onSubmit={submit}>
          <input type="hidden" name="page_path" value={path} />
          <label style={label}>種別<select name="kind" style={field}><option value="bug">不具合</option><option value="request">要望</option></select></label>
          <label style={label}>タイトル<input name="title" required style={field} /></label>
          <label style={label}>内容<textarea name="body" required rows={5} style={{ ...field, resize: "vertical" }} /></label>
          <p style={{ margin: "5px 0", color: "#6b7280", fontSize: 12 }}>Ctrl+V で画像を貼り付けることもできます。</p>
          <label style={label}>スクリーンショット（任意）<input ref={fileRef} type="file" name="screenshot" accept="image/*" onChange={(e) => setFileName(e.target.files?.[0]?.name || "")} style={{ ...field, padding: 7 }} /></label>
          {fileName && <p style={{ color: "#6b7280", fontSize: 12 }}>選択中: {fileName}</p>}
          {error && <p role="alert" style={{ padding: 9, borderRadius: 6, background: "#fef2f2", color: "#b91c1c", fontSize: 13 }}>{error}</p>}
          <button disabled={sending} type="submit" style={{ width: "100%", marginTop: 16, border: 0, borderRadius: 8, padding: 11, background: sending ? "#9ca3af" : "#f59e0b", color: "white", fontWeight: 700, cursor: sending ? "wait" : "pointer" }}>{sending ? "送信中…" : "送信"}</button>
        </form>
      </div>
    </div>}
    {!hideFloatingButton && <button type="button" aria-expanded={open} onClick={() => { setError(""); setOpen(true); }} style={{ position: "fixed", right: 20, bottom: 20, zIndex: z - 1, border: 0, borderRadius: 999, padding: "12px 18px", background: "#f59e0b", color: "white", fontWeight: 700, boxShadow: "0 6px 20px rgba(0,0,0,.25)", cursor: "pointer" }}>🐛 不具合・要望</button>}
    {toast && <div role="status" style={{ position: "fixed", left: "50%", bottom: 30, zIndex: z + 1, transform: "translateX(-50%)", borderRadius: 8, padding: "12px 18px", background: "#166534", color: "white", boxShadow: "0 6px 20px rgba(0,0,0,.25)" }}>送信しました。ありがとうございます！</div>}
  </>;
}
