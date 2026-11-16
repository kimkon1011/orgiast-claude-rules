import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { Visitor, VisitorInput } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dataFile = path.join(process.cwd(), "data", "visitors.json");

async function readVisitors(): Promise<Visitor[]> {
  try {
    return JSON.parse(await fs.readFile(dataFile, "utf8")) as Visitor[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function GET() {
  const visitors = await readVisitors();
  return NextResponse.json(visitors.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export async function POST(request: Request) {
  const input = (await request.json()) as Partial<VisitorInput>;
  const fields = ["name", "company", "title", "email", "phone"] as const;
  if (fields.some((field) => typeof input[field] !== "string" || !input[field]?.trim())) {
    return NextResponse.json({ message: "すべての項目を入力してください。" }, { status: 400 });
  }

  const visitor: Visitor = {
    id: crypto.randomUUID(),
    name: input.name!.trim(),
    company: input.company!.trim(),
    title: input.title!.trim(),
    email: input.email!.trim(),
    phone: input.phone!.trim(),
    createdAt: new Date().toISOString(),
  };
  const visitors = await readVisitors();
  visitors.push(visitor);
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, `${JSON.stringify(visitors, null, 2)}\n`, "utf8");
  return NextResponse.json(visitor, { status: 201 });
}
