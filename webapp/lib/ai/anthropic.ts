import Anthropic from '@anthropic-ai/sdk';

/**
 * Memoized Anthropic client. Server-only — never import from client code.
 * Throws a descriptive error when ANTHROPIC_API_KEY is missing so API routes
 * can map it to a 500 {error:'anthropic_not_configured'} before any DB writes.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to webapp/.env.local (and Vercel env) to enable draft generation.'
    );
  }
  client = new Anthropic({ apiKey });
  return client;
}
