import Stripe from 'stripe';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(req) {
  try {
    const { tier, bidText, side } = await req.json();

    const prices = {
      single: { amount: 7900, name: 'Single Bid Review' },
      compare: { amount: 14900, name: 'Compare Bids' },
      full: { amount: 35900, name: 'Full Project Coverage' },
    };

    const selected = prices[tier] || prices.single;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: selected.name },
            unit_amount: selected.amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/`,
      metadata: {
        tier,
        side: side || 'receiving',
        bidPreview: (bidText || '').substring(0, 200),
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}