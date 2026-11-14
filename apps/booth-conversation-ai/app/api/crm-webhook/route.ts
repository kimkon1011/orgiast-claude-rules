import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { CrmExport } from "@/app/types";
import { isLeadScore, isObject, isText, isVisitor } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const dataFile = path.join(process.cwd(), "data", "crm-export.json");
// Serialize writes within this local mock server so simultaneous exports are not lost.
let pendingWrite: Promise<void> = Promise.resolve();

async function readExports(): Promise<CrmExport[]> {
  try {
    const records: unknown = JSON.parse(await fs.readFile(dataFile, "utf8"));
    if (!Array.isArray(records)) throw new Error("Invalid CRM store");
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!isObject(body) || !isVisitor(body.visitor) || !isText(body.conversationText) ||
      !isLeadScore(body.scores) || !isObject(body.emailDraft) ||
      !isText(body.emailDraft.subject, 500) || !isText(body.emailDraft.body)) {
    return NextResponse.json({ message: "来場者情報・会話・リード評価・メール案を確認してください。" }, { status: 400 });
  }
  const record: CrmExport = {
    id: crypto.randomUUID(), visitor: body.visitor, conversationText: body.conversationText,
    scores: body.scores, emailDraft: { subject: body.emailDraft.subject, body: body.emailDraft.body },
    exportedAt: new Date().toISOString(),
  };
  const write = pendingWrite.then(async () => {
    const records = await readExports();
    records.push(record);
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.${record.id}.tmp`;
    try {
      await fs.writeFile(temporaryFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      await fs.rename(temporaryFile, dataFile);
    } finally {
      await fs.rm(temporaryFile, { force: true });
    }
  });
  pendingWrite = write.catch(() => undefined);
  try {
    await write;
    return NextResponse.json({ success: true, exportedAt: record.exportedAt, recordId: record.id });
  } catch {
    return NextResponse.json({ message: "CRMデータの保存に失敗しました。" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const records = await readExports();
    return NextResponse.json(records.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt)));
  } catch {
    return NextResponse.json({ message: "CRM履歴を読み込めませんでした。" }, { status: 500 });
  }
}
