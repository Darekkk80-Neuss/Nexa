// Effyra – Stripe-Webhook (Supabase Edge Function)
// Setzt nach erfolgreicher Zahlung die Stufe / das Kontingent (service_role).
// In Stripe als Webhook-Endpoint eintragen; diese Function OHNE JWT-Prüfung
// deployen (Signatur wird über STRIPE_WEBHOOK_SECRET verifiziert):
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Benötigte Secrets:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@16?target=deno';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
  const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20', httpClient: Stripe.createFetchHttpClient() });
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, WEBHOOK_SECRET);
  } catch (err) {
    return new Response('signature verification failed: ' + (err as Error).message, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE);
  const userIdByCustomer = async (customer: string | null) => {
    if (!customer) return null;
    const { data } = await admin.from('profiles').select('id').eq('stripe_customer_id', customer).maybeSingle();
    return data?.id || null;
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const uid = s.client_reference_id || (s.metadata?.uid ?? null);
        const kind = s.metadata?.kind;
        if (uid && typeof s.customer === 'string') await admin.rpc('set_stripe_customer', { p_user: uid, p_customer: s.customer });
        if (uid && kind) await admin.rpc('apply_purchase', { p_user: uid, p_kind: kind });
        break;
      }
      case 'invoice.paid': {
        // Nur echte Abo-Verlängerungen (Erstzahlung läuft über checkout.session.completed)
        const inv = event.data.object as Stripe.Invoice;
        if (inv.billing_reason === 'subscription_cycle') {
          const uid = await userIdByCustomer(inv.customer as string);
          if (uid) await admin.rpc('apply_purchase', { p_user: uid, p_kind: 'premium' });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const uid = await userIdByCustomer(sub.customer as string);
        if (uid) await admin.from('profiles').update({ premium_until: new Date().toISOString() }).eq('id', uid);
        break;
      }
    }
  } catch (err) {
    return new Response('handler error: ' + (err as Error).message, { status: 500 });
  }

  return new Response('ok', { status: 200 });
});
