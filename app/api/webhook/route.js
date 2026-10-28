import Stripe from 'stripe';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const unlockedSessions = new Map();

export async function POST(req) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;
    const email = session.customer_details?.email || session.customer_email;
    const tier = session.metadata?.tier || 'single';

    unlockedSessions.set(sessionId, {
      unlocked: true,
      email,
      tier,
      paidAt: new Date().toISOString(),
    });

    console.log(`Payment completed: ${sessionId} — ${email} — tier ${tier}`);
  }

  return NextResponse.json({ received: true });
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');
  if (!sessionId) return NextResponse.json({ unlocked: false });

  const data = unlockedSessions.get(sessionId);
  return NextResponse.json({ unlocked: !!data, ...data });
}