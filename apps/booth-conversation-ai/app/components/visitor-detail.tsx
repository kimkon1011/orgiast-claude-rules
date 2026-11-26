"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Visitor } from "@/app/types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function VisitorDetail({ visitor }: { visitor: Visitor }) {
  const [qr, setQr] = useState("");
  useEffect(() => { QRCode.toDataURL(visitor.id, { width: 240, margin: 2 }).then(setQr); }, [visitor.id]);
  const details = [["会社名", visitor.company], ["役職", visitor.title], ["メールアドレス", visitor.email], ["電話番号", visitor.phone], ["登録日時", new Date(visitor.createdAt).toLocaleString("ja-JP")]];
  return <Card className="mx-auto max-w-2xl"><CardHeader><p className="text-sm font-medium text-emerald-700">来場者詳細</p><CardTitle className="text-2xl">{visitor.name} 様</CardTitle></CardHeader><CardContent className="grid gap-8 md:grid-cols-[1fr_auto]"> <dl className="divide-y">{details.map(([label, value]) => <div key={label} className="py-3"><dt className="text-xs font-medium text-slate-400">{label}</dt><dd className="mt-1 break-all text-sm font-medium">{value}</dd></div>)}</dl><div className="flex flex-col items-center justify-center">{qr && <>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={qr} alt={`${visitor.name}様のQRコード`} className="h-52 w-52 rounded-xl border p-2" /><p className="mt-2 text-xs text-slate-400">来場者QRコード</p></>}</div></CardContent></Card>;
}
