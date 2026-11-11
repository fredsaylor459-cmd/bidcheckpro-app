import { NextResponse } from 'next/server';
import { handleWebhook, handleWebhookGet } from '../../../lib/handlers.js';

export async function POST(req) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');
  const result = await handleWebhook(rawBody, signature);
  return NextResponse.json(result.json, { status: result.status });
}

export async function GET() {
  const result = handleWebhookGet();
  return NextResponse.json(result.json, { status: result.status });
}
