import { NextRequest } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { readWatches } from '@/lib/watches.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = checkAuth(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  return Response.json(await readWatches(), { headers: { 'Cache-Control': 'private, no-store' } });
}
