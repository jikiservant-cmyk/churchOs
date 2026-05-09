import { NextResponse } from 'next/server';
import { createClient as createSupabaseServerClient } from '@/lib/supabase/server';
// @ts-ignore
import Africastalking from 'africastalking';
import { normalizeUgPhone } from '@/lib/utils';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { phoneNumber, message, churchId } = body;

    console.log(`[SMS API] Request received for phone: ${phoneNumber}, churchId: ${churchId}`);

    // 1. Authenticate User & Enforce Multi-Tenancy
    // This is CRITICAL for security. We verify the user's identity first.
    const supabaseUserClient = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabaseUserClient.auth.getUser();

    if (authError || !user) {
      console.warn('[SMS API] Unauthorized attempt to send SMS.');
      return NextResponse.json({ error: 'Unauthorized access' }, { status: 401 });
    }

    // 2. Verify Tenant (Church) Ownership Explicitly via Admin Profile
    // We check if the authenticated user explicitly belongs to this churchId via admin_profiles.
    const { data: adminProfile } = await supabaseUserClient
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (!adminProfile) {
      console.error(`[SMS API] Explicit multi-tenancy check failed. User ${user.id} attempted to send for church ${churchId}`);
      return NextResponse.json({ error: 'Access denied: You are not authorized as an admin for this church.' }, { status: 403 });
    }
    
    const { data: authorizedChurch, error: tenantError } = await supabaseUserClient
      .schema('church')
      .from('churches')
      .select('id, sender_id')
      .eq('id', churchId)
      .maybeSingle();

    if (tenantError || !authorizedChurch) {
      console.error(`[SMS API] Church lookup failed for ${churchId}`);
      return NextResponse.json({ error: 'Church configuration not found.' }, { status: 404 });
    }

    // 3. Prepaid Balance Guard
    // We check the wallet BEFORE calling the expensive carrier API.
    let { data: balance, error: balanceError } = await supabaseUserClient
      .schema('public')
      .from('wallets')
      .select('balance, sms_rate')
      .eq('tenant_id', churchId)
      .maybeSingle();

    if (balanceError) {
      return NextResponse.json({ error: 'Billing lookup error. Please try again later.' }, { status: 500 });
    }

    // Auto-provision tenant & wallet for backward compatibility if missing
    // (For churches that were created before the new triggers were added)
    if (!balance) {
      // 1. Ensure tenant exists
      const { error: tenantInsertError } = await supabaseUserClient
        .schema('public')
        .from('tenants')
        .upsert({ id: churchId, app_type: 'church', name: authorizedChurch.sender_id || 'Church' })
        .select()
        .single();
      
      if (tenantInsertError) {
        console.error('[SMS API] Failed to auto-provision tenant:', tenantInsertError);
      } else {
        // 2. The tenant trigger *should* auto-create the wallet, but in case it
        // doesn't fire immediately or fails due to permissions, we'll force provision it here:
        const { data: newBalance, error: initError } = await supabaseUserClient
          .schema('public')
          .from('wallets')
          .upsert({ tenant_id: churchId, balance: 0, sms_rate: 70, app_type: 'church' })
          .select('balance, sms_rate')
          .single();
          
        if (!initError && newBalance) {
          balance = newBalance;
        }
      }
    }

    if (!balance) {
      return NextResponse.json({ error: 'Billing account not found.' }, { status: 400 });
    }

    if (balance.balance < balance.sms_rate) {
      return NextResponse.json({ 
        error: 'Insufficient SMS balance.', 
        balance: balance.balance, 
        rate: balance.sms_rate,
        remaining: Math.floor(balance.balance / balance.sms_rate)
      }, { status: 402 }); // 402 Payment Required
    }

    // 4. Validate Input
    if (!phoneNumber || !message) {
      return NextResponse.json(
        { error: 'Missing required fields: phoneNumber or message' },
        { status: 400 }
      );
    }

    // 4. Normalize the phone number one last time for safety
    const finalPhone = normalizeUgPhone(phoneNumber);
    
    // 5. Validate Credentials
    const apiKey = process.env.AT_API_KEY;
    const username = process.env.AT_USERNAME;

    if (!apiKey || !username) {
      console.error('[SMS API] Africa\'s Talking credentials missing.');
      return NextResponse.json(
        { error: 'Service configuration error' },
        { status: 500 }
      );
    }

    // Default to a blank configuration if sandbox
    const isSandbox = process.env.AT_USERNAME?.toLowerCase() === 'sandbox';
    let senderId = '';
    
    // AT strict requirements: 
    // 1. Sandbox mode: Strictly OMIT 'from' (senderId) unless using a Sandbox shortcode.
    // 2. Production mode: Only use a Sender ID if the church explicitly set one in the db. 
    // If we pass an arbitrary string like 'CHURCHPAY' that they don't own, the live API will reject it.
    if (!isSandbox && authorizedChurch.sender_id && authorizedChurch.sender_id.trim() !== '') {
       senderId = authorizedChurch.sender_id.trim();
    }

    // 5. Initialize Africa's Talking Client
    const africastalking = Africastalking({ apiKey, username });
    const sms = africastalking.SMS;

    // 6. Create Initial "PENDING" Log
    // This provides immediate feedback in the dashboard and reserves an idempotency key.
    // The database trigger will NOT debit yet because status is 'PENDING'.
    const idempotencyKey = body.idempotencyKey || `sms_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    const insertPayload = {
        tenant_id: churchId,
        recipient_phone: finalPhone,
        body: message,
        status: 'PENDING',
        idempotency_key: idempotencyKey
    };

    console.log('[SMS API] Attempting to insert into sms_logs row:', insertPayload);

    const { data: initialLog, error: initialLogError } = await supabaseUserClient
      .schema('church')
      .from('sms_logs')
      .insert(insertPayload)
      .select('id')
      .single();

    if (initialLogError) {
      console.error('[SMS API] Failed to create initial pending log:', initialLogError);
      return NextResponse.json({ 
        error: `Database Insert Error: ${initialLogError.message || 'Failed to initialize message log.'}`,
        details: initialLogError 
      }, { status: 500 });
    }

    const logId = initialLog.id;

    // 7. Send the SMS
    try {
      const payload: any = {
        to: finalPhone,
        message: message,
      };

      if (senderId) {
        payload.from = senderId;
      }

      // Diagnostic Log
      if (isSandbox) {
        console.info(`[SMS API] Sending Sandbox payload:`, JSON.stringify(payload));
      }

      let response = await sms.send(payload);
      console.log("SMS provider response:", JSON.stringify(response, null, 2));
      
      let messageData = response.SMSMessageData;
      let recipients = messageData?.Recipients || [];

      // Smart Fallback: If AT rejects the custom Sender ID, strip it and retry using the default unbranded shortcode
      if (recipients.length === 0) {
        const errorMessage = messageData?.Message || response.Message || '';
        
        if (errorMessage.includes('InvalidSenderId') && payload.from) {
           console.warn(`[SMS API] Africa's Talking rejected custom Sender ID '${payload.from}'. Retrying without Sender ID...`);
           delete payload.from; // Strip the invalid Sender ID
           
           // Retry without 'from'
           response = await sms.send(payload);
           console.log("SMS provider retry response:", JSON.stringify(response, null, 2));
           
           messageData = response.SMSMessageData;
           recipients = messageData?.Recipients || [];
        }
      }

      if (recipients.length === 0) {
        // Africa's Talking often packs the actual error reason in the 'Message' field if Recipients is empty
        const errorMessage = messageData?.Message || response.Message || 'Zero recipients returned from provider';
        throw new Error(`Africa's Talking API rejection: ${errorMessage}`);
      }

      const recipient = recipients[0];

      // AT considers Success, Sent, or Queued variants as successful dispatch
      const successStatuses = ['Success', 'Sent', 'Queued', 'Buffered'];
      const isSuccess = successStatuses.includes(recipient.status);
      const finalStatus = isSuccess ? recipient.status : 'FAILED';

      // 8. Update Log to Final Status (This triggers the atomic DEBIT only if result is billable)
      // Billable statuses: 'Success', 'Sent', 'Queued', 'Buffered'
      const { error: updateError } = await supabaseUserClient
        .schema('church')
        .from('sms_logs')
        .update({
          status: finalStatus,
          message_provider_status: recipient.status,
          provider_message_id: recipient.messageId,
          error_message: isSuccess ? null : recipient.status,
          updated_at: new Date().toISOString()
        })
        .eq('id', logId);

      if (updateError) {
        // If this fails with "Insufficient SMS balance", it's because the trigger blocked the update!
        console.error('[SMS API] Final status update failed:', updateError.message);
        return NextResponse.json({ 
          error: updateError.message.includes('Insufficient SMS balance') 
            ? 'Broadcast halted: Insufficient SMS balance.' 
            : 'Failed to finalize SMS log.' 
        }, { status: updateError.message.includes('Insufficient SMS balance') ? 402 : 500 });
      }

      if (successStatuses.includes(recipient.status)) {
        
        // MANUALLY DEDUCT WALLET BALANCE (In case DB trigger isn't applied)
        try {
          const { error: deductErr } = await supabaseUserClient
            .from('wallets')
            .update({ 
               balance: balance.balance - balance.sms_rate,
               last_updated: new Date().toISOString()
            })
            .eq('tenant_id', churchId);
            
          if (!deductErr) {
            // Log manually as well
            await supabaseUserClient.from('wallet_transactions').insert({
              tenant_id: churchId,
              amount: -balance.sms_rate,
              type: 'SMS_SENT',
              description: `Sent 1 SMS to ${finalPhone}`,
              reference_code: `CODE_${logId}`,
              status: 'success',
              idempotency_key: logId,
              product: 'sms',
              reference_id: logId
            });
          }
        } catch (dbErr) {
          console.error('[SMS API] Code-side deduction logic failed:', dbErr);
        }

        return NextResponse.json({ 
          success: true, 
          messageId: recipient.messageId,
          status: recipient.status,
          senderId: senderId
        });
      } else {
        const failureReason = recipient.status || 'Unknown failure';
        console.error(`[SMS API] AT Delivery failed for ${phoneNumber}:`, failureReason);
        
        return NextResponse.json({ 
          success: false, 
          error: `SMS delivery failed: ${failureReason}`, 
          details: recipient
        }, { status: 502 });
      }

    } catch (atError: any) {
      console.error('[SMS API] Africa\'s Talking submission error:', atError);
      
      // Update log to FAILED so pastor sees it in history
      await supabaseUserClient
        .schema('church')
        .from('sms_logs')
        .update({ 
          status: 'FAILED', 
          error_message: atError.message || String(atError),
          updated_at: new Date().toISOString()
        })
        .eq('id', logId);

      return NextResponse.json(
        { error: 'Failed to communicate with Africa\'s Talking API', details: atError.message || String(atError) },
        { status: 502 }
      );
    }

  } catch (error: any) {
    console.error('[SMS API] Unexpected error in SMS route:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error while sending SMS' },
      { status: 500 }
    );
  }
}
