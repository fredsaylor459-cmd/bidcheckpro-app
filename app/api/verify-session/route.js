import Stripe from 'stripe';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(req) {
  try {
    const { sessionId } = await req.json();
    if (!sessionId) return NextResponse.json({ paid: false });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid';

    return NextResponse.json({
      paid,
      tier: session.metadata?.tier,
      email: session.customer_details?.email,
    });
  } catch (err) {
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}