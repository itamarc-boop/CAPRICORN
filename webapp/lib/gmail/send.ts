import { google } from 'googleapis';
import { makeAuthedClient, type IntegrationRow } from './oauth';

export type SendResult = {
  gmail_message_id: string;
  from_email: string;
};

/**
 * Send a plain-text email via the connected Gmail mailbox.
 * Builds an RFC 5322 message and base64url-encodes it for the Gmail API.
 */
export async function sendEmail(
  integration: IntegrationRow,
  { to, subject, body }: { to: string; subject: string; body: string }
): Promise<SendResult> {
  const oauth2 = makeAuthedClient(integration);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const from = integration.account_email;
  const raw = buildRawMessage({ from, to, subject, body });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  const id = res.data.id;
  if (!id) throw new Error('Gmail send returned no message id');
  return { gmail_message_id: id, from_email: from };
}

function buildRawMessage({
  from, to, subject, body,
}: { from: string; to: string; subject: string; body: string }): string {
  // Header-injection hardening: strip CR/LF before interpolating into headers.
  const sanitizeHeader = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  from = sanitizeHeader(from);
  to = sanitizeHeader(to);
  subject = sanitizeHeader(subject);
  if (/\s/.test(to) || !to.includes('@')) {
    throw new Error('invalid recipient address: ' + to);
  }
  // RFC 2047 encoded-word for non-ASCII subjects
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?utf-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
    : subject;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
