import { NextRequest } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { readWatches } from '@/lib/watches.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let pending: ReturnType<typeof readWatches> | undefined;
let expires = 0;

export async function GET(req: NextRequest) {
  const auth = checkAuth(req);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  if (!pending || Date.now() >= expires) {
    expires = Infinity;
    pending = readWatches().then(data => { expires = Date.now() + 30000; return data; })
      .catch(error => { pending = undefined; expires = 0; throw error; });
  }
  return Response.json(await pending, { headers: { 'Cache-Control': 'private, no-store' } });
}
