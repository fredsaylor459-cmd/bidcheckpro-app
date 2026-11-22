import { NextResponse } from 'next/server';
import { handleReview } from '../../../lib/handlers.js';

export async function POST(req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.', code: 'invalid_json' }, { status: 400 });
  }
  const result = await handleReview(body);
  return NextResponse.json(result.json, { status: result.status });
}
