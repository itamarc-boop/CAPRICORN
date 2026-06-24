import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getAnthropic } from '@/lib/ai/anthropic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/products/suggest-keywords  { name }
 * Expands a plain-language product into the importer/distributor search terms
 * Explorium matches on, so the client doesn't have to think in keywords.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'Missing product name.' }, { status: 400 });

  let client;
  try {
    client = getAnthropic();
  } catch {
    return NextResponse.json({ error: 'AI is not configured.' }, { status: 503 });
  }

  const prompt =
    `Capricorn is a global sourcing company that sells to importers and distributors of ` +
    `physical consumer and industrial goods.\n` +
    `For the product category "${name}", list 6-10 short search keywords used to find the ` +
    `IMPORTERS and DISTRIBUTORS of that product in business directories.\n` +
    `Favor importer / distributor / wholesale intent plus the specific product terms. Avoid generic words.\n` +
    `Return ONLY a single comma-separated line of keywords — no preamble, no numbering, no quotes.`;

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6', // matches the app's other AI calls (lib/ai/draft.ts)
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    const keywords = text
      .replace(/\s*\n\s*/g, ' ')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!keywords) return NextResponse.json({ error: 'No suggestions returned.' }, { status: 502 });
    return NextResponse.json({ keywords });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'AI request failed.' },
      { status: 502 },
    );
  }
}
