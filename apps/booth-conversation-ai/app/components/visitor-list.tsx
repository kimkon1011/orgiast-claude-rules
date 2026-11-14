"use client";

import { Building2, UserRound } from "lucide-react";
import type { Visitor } from "@/app/types";
import { cn } from "@/lib/utils";

export function VisitorList({ visitors, selectedId, onSelect }: { visitors: Visitor[]; selectedId?: string; onSelect: (visitor: Visitor) => void }) {
  return <div className="space-y-2">{visitors.length === 0 ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400"><UserRound className="mx-auto mb-2 h-7 w-7" />まだ登録はありません</div> : visitors.map((visitor) => (
    <button key={visitor.id} onClick={() => onSelect(visitor)} className={cn("w-full rounded-xl border p-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50", selectedId === visitor.id ? "border-emerald-400 bg-emerald-50" : "bg-white")}>
      <p className="truncate font-semibold text-slate-800">{visitor.name}</p><p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500"><Building2 className="h-3 w-3" />{visitor.company}</p>
    </button>
  ))}</div>;
}
