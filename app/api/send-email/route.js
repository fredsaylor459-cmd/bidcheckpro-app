import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { to, subject, html, text } = await req.json();
    if (!to || !subject) {
      return NextResponse.json({ error: 'Missing to or subject' }, { status: 400 });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'RESEND_API_KEY not set' }, { status: 500 });
    }

    const from = process.env.RESEND_FROM || 'BidCheckPro <reviews@bidcheckpro.com>';

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || text,
        text,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('Resend error:', data);
      return NextResponse.json({ error: data.message || 'Email failed' }, { status: res.status });
    }

    return NextResponse.json({ ok: true, id: data.id });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Email send failed' }, { status: 500 });
  }
}