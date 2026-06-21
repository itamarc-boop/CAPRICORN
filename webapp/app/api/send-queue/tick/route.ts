/**
 * GET/POST /api/send-queue/tick
 * Cron-driven queue worker. Authenticated by CRON_SECRET (Bearer header),
 * NOT by a user session — Vercel Cron and external schedulers hit this with
 * no cookies. Each invocation performs at most one unit of work (recover one
 * batch of stuck sends, or send one due draft). See lib/queue/tick.ts.
 *
 * Vercel Cron uses GET; manual/scripted triggers can use POST. Same handler.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { runTick } from '@/lib/queue/tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await runTick(getServiceSupabase());
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
