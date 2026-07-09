// Effyra – Stripe-Checkout (Supabase Edge Function)
// Erstellt eine Stripe-Checkout-Session für Medium (einmalig), Premium (Abo)
// oder Top-up (+500, einmalig) und gibt die Checkout-URL zurück.
//
// Benötigte Secrets:
//   STRIPE_SECRET_KEY        (sk_test_… / sk_live_…)
//   STRIPE_PRICE_MEDIUM      (price_… für 4,99 € einmalig)
//   STRIPE_PRICE_PREMIUM     (price_… für 4,99 €/Monat, wiederkehrend)
//   STRIPE_PRICE_TOPUP       (price_… für 4,99 € einmalig, +500 Abfragen)
//   APP_URL                  (z. B. https://darekkk80-neuss.github.io/Nexa/)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@16?target=deno';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  const APP_URL = (Deno.env.get('APP_URL') || '').replace(/\/+$/, '') + '/';
  const PRICES: Record<string, string | undefined> = {
    medium: Deno.env.get('STRIPE_PRICE_MEDIUM'),
    premium: Deno.env.get('STRIPE_PRICE_PREMIUM'),
    topup: Deno.env.get('STRIPE_PRICE_TOPUP'),
  };
  if (!STRIPE_SECRET_KEY) return json({ error: 'server_not_configured' }, 500);

  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);
  const user = ures.user;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const kind = body?.kind;
  const price = PRICES[kind];
  if (!price) return json({ error: 'unknown_product' }, 400);

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20', httpClient: Stripe.createFetchHttpClient() });
  const admin = createClient(SUPABASE_URL, SERVICE);

  // Bestehenden Stripe-Kunden wiederverwenden oder anlegen
  let customerId: string | undefined;
  const { data: prof } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
  customerId = prof?.stripe_customer_id || undefined;
  if (!customerId) {
    const c = await stripe.customers.create({ email: user.email, metadata: { uid: user.id } });
    customerId = c.id;
    await admin.rpc('set_stripe_customer', { p_user: user.id, p_customer: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    mode: kind === 'premium' ? 'subscription' : 'payment',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { uid: user.id, kind },
    success_url: APP_URL + '?checkout=success',
    cancel_url: APP_URL + '?checkout=cancel',
    allow_promotion_codes: true,
  });

  return json({ url: session.url }, 200);
});
