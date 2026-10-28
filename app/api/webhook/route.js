import Stripe from 'stripe';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const unlockedSessions = new Map();

async function generateFullReview(bidText, side) {
  const apiKey = process.env.AI_API_KEY;
  const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';

  if (!apiKey || !bidText) {
    return {
      summary: 'Full review unlocked. Paste your bid on the site for the detailed flags.',
      flags: [],
      questions: [
        'Are permits and inspection fees included?',
        'What is the contingency capped at?',
        'Can you break out labor hours by phase?',
      ],
    };
  }

  const systemPrompt = `You are a construction estimator with 36 years of field experience.
Review the bid. Return ONLY valid JSON:
{
  "flags": [{"line":"...","issue":"...","note":"...","severity":"high|medium|low"}],
  "summary": "2-3 sentence overall take",
  "questions": ["q1","q2","q3"]
}
Side: ${side === 'sending' ? 'contractor sending (find omissions)' : 'homeowner received (find padding)'}
This is a paid full review. Be thorough.`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: bidText },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) throw new Error('AI failed');
    const data = await response.json();
    return JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    console.error('Review generation failed', e);
    return {
      summary: 'Payment received. Full review is ready — paste the bid on the site to generate it.',
      flags: [],
      questions: [],
    };
  }
}

function buildEmailHtml(review, tier, email) {
  const flagsHtml = (review.flags || [])
    .map(
      (f) =>
        `<div style="background:#f8ece9;border-left:3px solid #b42318;padding:10px;margin:8px 0;">
          <strong>${f.line}</strong> — ${f.issue} (${f.severity})<br>
          <span style="font-size:14px;">${f.note}</span>
        </div>`
    )
    .join('');

  const questionsHtml = (review.questions || [])
    .map((q) => `<li>${q}</li>`)
    .join('');

  return `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#161614;">
      <h1 style="font-size:24px;">Your BidCheckPro Review</h1>
      <p>Payment confirmed for the <strong>${tier}</strong> tier.</p>
      <p><strong>Summary:</strong> ${review.summary || 'Review complete.'}</p>
      ${flagsHtml ? `<h2>Flags</h2>${flagsHtml}` : ''}
      ${questionsHtml ? `<h2>Questions to ask</h2><ul>${questionsHtml}</ul>` : ''}
      <p style="margin-top:24px;font-size:14px;color:#5c5a54;">
        Clean bid with nothing worth flagging = refund.<br>
        Questions? Reply to this email.
      </p>
    </div>
  `;
}

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
    const side = session.metadata?.side || 'receiving';
    const bidText = session.metadata?.bidPreview || '';

    unlockedSessions.set(sessionId, {
      unlocked: true,
      email,
      tier,
      paidAt: new Date().toISOString(),
    });

    console.log(`Payment completed: ${sessionId} — ${email} — tier ${tier}`);

    if (email && process.env.RESEND_API_KEY) {
      const review = await generateFullReview(bidText, side);
      const html = buildEmailHtml(review, tier, email);
      const text = `Your BidCheckPro ${tier} review is ready.\n\nSummary: ${review.summary || ''}\n\nVisit the site to paste the full bid for detailed flags.`;

      try {
        await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'https://bidcheckpro-app.vercel.app'}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: email,
            subject: `Your BidCheckPro Review (${tier})`,
            html,
            text,
          }),
        });
        console.log('Review email sent to', email);
      } catch (e) {
        console.error('Failed to send review email', e);
      }
    }
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