import { NextResponse } from 'next/server';
import { handleSendEmail } from '../../../lib/handlers.js';

export async function POST() {
  const result = await handleSendEmail();
  return NextResponse.json(result.json, { status: result.status });
}
