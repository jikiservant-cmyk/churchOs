/**
 * POST|GET /api/sms/process-queue
 *
 * Claims and delivers a batch of PENDING sms_queue items. Intended for a
 * scheduler (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * In-app enqueue paths call `processQueueBatch` directly and do not use this.
 *
 * Fails CLOSED: with neither QUEUE_PROCESSOR_SECRET nor CRON_SECRET configured
 * the endpoint is disabled (it used to be open to the internet).
 */
import { NextResponse } from 'next/server';
import { processQueueBatch } from '@/lib/queue-actions';
import { safeEqual, isUuid } from '@/lib/security';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Gate = { ok: true } | { ok: false; status: number };

function authorise(req: Request): Gate {
  const secrets = [process.env.QUEUE_PROCESSOR_SECRET, process.env.CRON_SECRET].filter((s): s is string => !!s && s.length >= 16);
  if (secrets.length === 0) return { ok: false, status: 503 };

  const candidates = [
    req.headers.get('x-queue-secret'),
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((c): c is string => !!c);

  // safeEqual hashes both sides, so comparison time does not depend on content or length.
  const ok = candidates.some((c) => secrets.some((s) => safeEqual(c, s)));
  return ok ? { ok: true } : { ok: false, status: 401 };
}

async function run(tenantId: string | undefined, batchSize: number) {
  try {
    const result = await processQueueBatch({ tenantId, batchSize: Math.max(1, Math.min(batchSize, 20)) });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[process-queue] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = authorise(req);
  if (!gate.ok) return NextResponse.json({ error: gate.status === 503 ? 'Not configured' : 'Unauthorized' }, { status: gate.status });

  const body = await req.json().catch(() => ({}));
  const tenantId = isUuid(body?.churchId) ? body.churchId : undefined;
  return run(tenantId, Number(body?.batchSize) || 15);
}

export async function GET(req: Request) {
  const gate = authorise(req);
  if (!gate.ok) return NextResponse.json({ error: gate.status === 503 ? 'Not configured' : 'Unauthorized' }, { status: gate.status });
  return run(undefined, 15);
}
