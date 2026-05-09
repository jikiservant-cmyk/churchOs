import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const { message, churchId, recipients } = await req.json();

  if (!message || !churchId || !recipients || !Array.isArray(recipients)) {
    return NextResponse.json({ error: 'Missing message, churchId, or recipients' }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const sendUpdate = (data: any) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
      };

      try {
        const supabase = await createClient();
        
        // Initial progress
        sendUpdate({ type: 'start', total: recipients.length });

        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          
          try {
            // Call the existing send API or implement logic here
            // For efficiency, we'll use a direct fetch to the internal send route
            // to leverage its balance checks and logging.
            const response = await fetch(`${process.env.APP_URL || 'http://localhost:3000'}/api/sms/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phoneNumber: recipient.phone_number,
                message: message
                  .replace(/{name}/gi, recipient.full_name || 'Member')
                  .replace(/{first_name}/gi, (recipient.full_name || 'Member').split(' ')[0]),
                churchId: churchId
              })
            });

            if (!response.ok) {
              const error = await response.json();
              sendUpdate({ type: 'error', recipient: recipient.full_name, error: error.error });
              
              if (response.status === 402) {
                sendUpdate({ type: 'halt', reason: 'Insufficient balance' });
                break;
              }
            } else {
              sendUpdate({ type: 'success', recipient: recipient.full_name, index: i });
            }
          } catch (err: any) {
            sendUpdate({ type: 'error', recipient: recipient.full_name, error: err.message });
          }

          // Small delay to prevent overwhelming
          await new Promise(r => setTimeout(r, 50));
        }

        sendUpdate({ type: 'complete' });
        controller.close();
      } catch (err: any) {
        sendUpdate({ type: 'fatal', error: err.message });
        controller.error(err);
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
