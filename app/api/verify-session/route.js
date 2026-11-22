import { NextResponse } from 'next/server';
import { handleVerifySession } from '../../../lib/handlers.js';

export async function POST(req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ paid: false, error: 'Invalid request.', code: 'invalid_json' }, { status: 400 });
  }
  const result = await handleVerifySession(body);
  return NextResponse.json(result.json, { status: result.status });
}
