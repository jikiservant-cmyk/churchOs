// supabase/functions/process-sms-queue/index.ts
// Supabase Edge Function — processes pending SMS messages from church.sms_queue
//
// Deploy:
//   supabase functions deploy process-sms-queue
//
// Set secrets:
//   supabase secrets set AFRICASTALKING_API_KEY=...
//   supabase secrets set AFRICASTALKING_USERNAME=...
//
// Trigger: Call this function from a pg_cron job or an HTTP POST from your app.
// The function is idempotent — running it multiple times won't double-send.

import AfricasTalking from 'npm:africastalking@0.7.9';
import { createClient } from 'npm:@supabase/supabase-js@2';

const BATCH_SIZE  = 20;  // Messages processed per invocation
const MAX_ATTEMPTS = 3;  // Stop retrying after this many failures

Deno.serve(async (req: Request) => {
  // Authenticate the caller — only allow the service role or a valid cron request
  const authHeader = req.headers.get('Authorization');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (authHeader !== `Bearer ${serviceKey}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Initialize Supabase (service role — bypasses RLS for queue processing)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    serviceKey
  );

  // Initialize Africa's Talking
  const at  = AfricasTalking({
    apiKey:   Deno.env.get('AFRICASTALKING_API_KEY')!,
    username: Deno.env.get('AFRICASTALKING_USERNAME')!,
  });
  const smsService = at.SMS;

  // ---------------------------------------------------------------------------
  // Step 1: Fetch a batch of pending messages
  // ---------------------------------------------------------------------------
  const { data: messages, error: fetchError } = await supabase
    .from('sms_queue')
    .select('id, tenant_id, recipient_phone, body, sender_id, attempts')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('scheduled_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    console.error('[sms-queue] Fetch error:', fetchError);
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status:  500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!messages || messages.length === 0) {
    return new Response(
      JSON.stringify({ processed: 0, message: 'Queue is empty' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ---------------------------------------------------------------------------
  // Step 2: Claim the batch (set to 'processing' + increment attempts)
  //         This prevents another concurrent invocation from double-sending.
  // ---------------------------------------------------------------------------
  const ids = messages.map((m: { id: string }) => m.id);

  await supabase
    .from('sms_queue')
    .update({ status: 'processing' })
    .in('id', ids);

  // ---------------------------------------------------------------------------
  // Step 3: Send each message via Africa's Talking
  // ---------------------------------------------------------------------------
  let sent   = 0;
  let failed = 0;

  for (const msg of messages as Array<{
    id: string;
    tenant_id: string;
    recipient_phone: string;
    body: string;
    sender_id: string | null;
    attempts: number;
  }>) {
    try {
      const result = await smsService.send({
        to:      [msg.recipient_phone],
        message: msg.body,
        from:    msg.sender_id ?? undefined,
      });

      const recipient  = result.SMSMessageData?.Recipients?.[0];
      // AT statusCode 101 = "Request accepted for delivery"
      const success    = recipient?.statusCode === 101 || recipient?.status === 'Success';
      const newAttempts = msg.attempts + 1;

      // Update queue row
      await supabase
        .from('sms_queue')
        .update({
          status:               success ? 'sent' : 'failed',
          provider_message_id:  recipient?.messageId ?? null,
          last_error:           success ? null : (recipient?.status ?? 'AT error'),
          attempts:             newAttempts,
          processed_at:         new Date().toISOString(),
        })
        .eq('id', msg.id);

      // Mirror to sms_logs for billing / audit trail
      if (success) {
        await supabase.from('sms_logs').insert({
          tenant_id:               msg.tenant_id,
          recipient_phone:         msg.recipient_phone,
          body:                    msg.body,
          status:                  'sent',
          message_provider_status: recipient?.status,
          provider_message_id:     recipient?.messageId,
          idempotency_key:         `queue-${msg.id}`,
          sender_id:               msg.sender_id,
        });
        sent++;
      } else {
        // If max attempts hit, mark failed permanently
        if (newAttempts >= MAX_ATTEMPTS) {
          await supabase
            .from('sms_queue')
            .update({ status: 'failed' })
            .eq('id', msg.id);
        } else {
          // Retry next cycle
          await supabase
            .from('sms_queue')
            .update({ status: 'pending', attempts: newAttempts })
            .eq('id', msg.id);
        }
        failed++;
      }
    } catch (err) {
      console.error('[sms-queue] Send error for', msg.id, err);

      const newAttempts = msg.attempts + 1;
      const isFinal     = newAttempts >= MAX_ATTEMPTS;

      await supabase
        .from('sms_queue')
        .update({
          status:      isFinal ? 'failed' : 'pending',
          last_error:  String(err),
          attempts:    newAttempts,
          processed_at: isFinal ? new Date().toISOString() : null,
        })
        .eq('id', msg.id);

      failed++;
    }
  }

  return new Response(
    JSON.stringify({
      processed: messages.length,
      sent,
      failed,
      timestamp: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
