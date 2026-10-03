/**
 * GET /api/sms/broadcast-status/[broadcastId]
 *
 * Returns real-time progress for a queued broadcast.
 * Poll this endpoint (e.g. every 2 s) from BroadcastComposer after
 * receiving a broadcastId from /api/sms/enqueue.
 *
 * Response shape:
 * {
 *   broadcastId:    string
 *   status:         'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED'
 *   total:          number   — total recipients enqueued
 *   sent:           number   — successfully delivered
 *   failed:         number   — permanently failed (max retries exhausted)
 *   pending:        number   — still waiting or being retried
 *   percentComplete: number  — 0-100
 *   createdAt:      string   — ISO timestamp
 *   completedAt:    string | null
 * }
 */

import { NextResponse } from 'next/server';
import { getCurrentTenantAdmin } from '@/lib/auth/tenant';
import { getBroadcastStatus } from '@/lib/queue-actions';
import { isUuid } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ broadcastId: string }> },
) {
  const admin = await getCurrentTenantAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { broadcastId } = await params;
  if (!isUuid(broadcastId)) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });

  const status = await getBroadcastStatus(broadcastId, admin.churchId);
  if (!status) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
  return NextResponse.json(status);
}
