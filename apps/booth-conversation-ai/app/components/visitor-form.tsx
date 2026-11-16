"use client";

import { useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { Visitor, VisitorInput } from "@/app/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const initialForm: VisitorInput = { name: "", company: "", title: "", email: "", phone: "" };
const fields: { key: keyof VisitorInput; label: string; type: string; placeholder: string }[] = [
  { key: "name", label: "お名前", type: "text", placeholder: "山田 太郎" },
  { key: "company", label: "会社名", type: "text", placeholder: "株式会社サンプル" },
  { key: "title", label: "役職", type: "text", placeholder: "営業部長" },
  { key: "email", label: "メールアドレス", type: "email", placeholder: "taro@example.jp" },
  { key: "phone", label: "電話番号", type: "tel", placeholder: "090-1234-5678" },
];

export function VisitorForm({ onRegistered }: { onRegistered: (visitor: Visitor) => void }) {
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState<{ visitor: Visitor; qr: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/visitors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message ?? "登録に失敗しました。");
      const visitor = (await response.json()) as Visitor;
      const qr = await QRCode.toDataURL(visitor.id, { width: 240, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } });
      setRegistered({ visitor, qr });
      setForm(initialForm);
      onRegistered(visitor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登録に失敗しました。");
    } finally { setSubmitting(false); }
  }

  if (registered) return (
    <Card className="mx-auto max-w-xl text-center">
      <CardContent className="flex flex-col items-center gap-4 p-8">
        <CheckCircle2 className="h-12 w-12 text-emerald-600" />
        <div><h2 className="text-2xl font-bold">登録が完了しました</h2><p className="mt-2 text-slate-500">{registered.visitor.name} 様の来場者QRコードです</p></div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={registered.qr} alt={`${registered.visitor.name}様の来場者QRコード`} className="h-60 w-60 rounded-xl border p-2" />
        <p className="break-all font-mono text-xs text-slate-400">ID: {registered.visitor.id}</p>
        <Button variant="outline" onClick={() => setRegistered(null)}>続けて登録する</Button>
      </CardContent>
    </Card>
  );

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader><CardTitle>来場者情報を登録</CardTitle><p className="mt-1 text-sm text-slate-500">受付に必要な情報を入力してください。</p></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-5 sm:grid-cols-2">
          {fields.map((field) => <div key={field.key} className={field.key === "name" || field.key === "company" ? "sm:col-span-2" : ""}><Label htmlFor={field.key}>{field.label}</Label><Input id={field.key} className="mt-2" type={field.type} placeholder={field.placeholder} value={form[field.key]} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} required /></div>)}
          {error && <p role="alert" className="text-sm text-red-600 sm:col-span-2">{error}</p>}
          <Button type="submit" className="sm:col-span-2" disabled={submitting}>{submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{submitting ? "登録しています…" : "登録してQRコードを発行"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
