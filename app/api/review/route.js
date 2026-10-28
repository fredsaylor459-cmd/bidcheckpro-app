import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { bidText, side, paid } = await req.json();
    if (!bidText || bidText.trim().length < 10) {
      return NextResponse.json({ error: 'Paste a bid with line items.' }, { status: 400 });
    }

    const apiKey = process.env.AI_API_KEY;
    const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';

    if (!apiKey) {
      return NextResponse.json(ruleBasedReview(bidText, side, paid));
    }

    const systemPrompt = `You are a construction estimator with 36 years of field experience (framing, finish, fabrication, remodels).
Review the bid below. Flag:
- Math errors or totals that don't add up
- Vague allowances or open contingencies
- Labor hours that look high or low for the scope
- Missing items (permits, disposal, second coats, blocking, punch list, etc.)
- Rates that appear padded
- Scope gaps

Return ONLY valid JSON in this shape:
{
  "flags": [
    {"line": "exact or shortened line text", "issue": "what's wrong", "note": "plain English explanation and what to ask", "severity": "high|medium|low"}
  ],
  "summary": "2-3 sentence overall take",
  "questions": ["question 1", "question 2", "question 3"]
}
Side: ${side === 'sending' ? 'contractor is sending this bid (find omissions)' : 'homeowner received this bid (find padding)'}
${paid ? 'This is a full paid review. Be thorough.' : 'This is a free preview. Return at most 2 flags.'}`;

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

    if (!response.ok) {
      return NextResponse.json(ruleBasedReview(bidText, side, paid));
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = ruleBasedReview(bidText, side, paid);
    }

    if (!paid && parsed.flags) {
      parsed.flags = parsed.flags.slice(0, 2);
      parsed.preview = true;
    }

    return NextResponse.json(parsed);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Review failed' }, { status: 500 });
  }
}

function ruleBasedReview(text, side, paid) {
  const lines = text.split('\n').filter(l => l.trim());
  const flags = [];
  lines.forEach(line => {
    const lower = line.toLowerCase();
    if (lower.includes('contingency') || lower.includes('allowance')) {
      flags.push({
        line,
        issue: 'Open or vague',
        note: 'Put a dollar amount or clear conditions on this. Open contingencies are how budgets die.',
        severity: 'high',
      });
    }
    if (/\d+\s*hr/.test(lower)) {
      const hrs = parseInt(lower.match(/\d+/)?.[0] || 0);
      if (hrs > 180) {
        flags.push({
          line,
          issue: 'High labor hours',
          note: 'Confirm what is included. Typical kitchen remodel framing is often lower unless walls are coming down.',
          severity: 'medium',
        });
      }
    }
    if (lower.includes('open') || lower.includes('tbd')) {
      flags.push({
        line,
        issue: 'Open item',
        note: 'This needs a number or clear scope before signing.',
        severity: 'high',
      });
    }
  });
  if (flags.length === 0) {
    flags.push({
      line: 'Overall',
      issue: 'No obvious soft numbers',
      note: 'Full review checks production rates, missing permits, disposal, and second coats.',
      severity: 'low',
    });
  }
  return {
    flags: paid ? flags : flags.slice(0, 2),
    summary: paid
      ? 'Full review complete. Check the flags and questions before you sign or send.'
      : 'Free preview. Paid review unlocks the full analysis and questions.',
    questions: [
      'Are permits and inspection fees included?',
      'What is the contingency capped at and when does it trigger?',
      'Can you break out labor hours by phase?',
    ],
    preview: !paid,
  };
}