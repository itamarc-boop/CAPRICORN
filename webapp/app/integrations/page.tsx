import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import { isOutlookConfigured } from '@/lib/outlook/oauth';

export const dynamic = 'force-dynamic';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Deterministic "Jun 11, 2026, 14:05" sliced from the ISO string as UTC, so
 *  there's no SSR/client locale drift (unlike toLocaleString). */
function fmtDateTimeUTC(iso: string | null): string {
  if (!iso) return '';
  const year = iso.slice(0, 4);
  const mi = parseInt(iso.slice(5, 7), 10) - 1;
  const day = parseInt(iso.slice(8, 10), 10);
  const hh = iso.slice(11, 13);
  const mm = iso.slice(14, 16);
  return `${MONTHS[mi] ?? ''} ${day}, ${year}, ${hh}:${mm} UTC`;
}

/** One connected mailbox/Drive row, with a Disconnect action. */
function ConnectedRow({
  i,
}: {
  i: { id: string; account_email: string; created_at: string; last_used_at: string | null };
}) {
  return (
    <div
      className="row-hover rounded px-3.5 py-2.5 flex items-center justify-between gap-3"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
    >
      <div className="min-w-0">
        <div className="font-tabular text-[13px] truncate" style={{ color: 'var(--ink)' }}>
          {i.account_email}
        </div>
        <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
          Connected {fmtDateTimeUTC(i.created_at)}
          {i.last_used_at && ` · last used ${fmtDateTimeUTC(i.last_used_at)}`}
        </div>
      </div>
      <form action="/api/integrations/disconnect" method="post" className="shrink-0">
        <input type="hidden" name="id" value={i.id} />
        <button type="submit" className="btn-unlink">
          Disconnect
        </button>
      </form>
    </div>
  );
}

type SearchParams = { status?: string; detail?: string };

export default async function IntegrationsPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  await requireAppUser();
  const sp = await searchParams;
  const supabase = await getServerSupabase();
  const { data: rows } = await supabase
    .from('integrations')
    .select('id, provider, account_email, created_at, last_used_at, scope')
    .in('provider', ['gmail', 'google_drive', 'outlook'])
    .order('created_at', { ascending: false });
  const integrations = (rows ?? []).filter((r) => r.provider === 'gmail');
  const driveIntegrations = (rows ?? []).filter((r) => r.provider === 'google_drive');
  const outlookIntegrations = (rows ?? []).filter((r) => r.provider === 'outlook');
  const outlookEnabled = isOutlookConfigured();

  const connectedCount =
    integrations.length + outlookIntegrations.length + driveIntegrations.length;

  return (
    <div className="max-w-2xl">
      <div
        className="flex items-end justify-between mb-8 pb-5 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <div>
          <div className="micro-label mb-2">Connections</div>
          <h1
            className="font-display text-[40px] leading-none"
            style={{ color: 'var(--navy-deep)' }}
          >
            Integrations
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{connectedCount}</span>{' '}
            {connectedCount === 1 ? 'account' : 'accounts'} connected
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            the mailbox you send from, and the Drive where your lead sheets are saved
          </p>
        </div>
      </div>

      {sp?.status === 'ok' && (
        <div
          className="mb-5 rounded px-3.5 py-2.5 text-[13px]"
          style={{ background: 'var(--ok-bg)', color: 'var(--ok-ink)' }}
        >
          {sp.detail === 'disconnected' ? (
            'Disconnected.'
          ) : (
            <>
              Connected: <span className="font-tabular">{sp.detail}</span>
            </>
          )}
        </div>
      )}
      {sp?.status === 'error' && (
        <div
          className="mb-5 rounded px-3.5 py-2.5 text-[13px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          {sp.detail === 'outlook_not_enabled'
            ? "Outlook isn't enabled yet. Ask your operator to add the Microsoft app credentials."
            : sp.detail === 'state_mismatch'
              ? 'That sign-in attempt expired. Please try connecting again.'
              : sp.detail?.startsWith('disconnect_failed')
                ? 'Could not disconnect. Please try again.'
                : `Could not connect: ${sp.detail}`}
        </div>
      )}

      <section
        className="card-soft p-6 space-y-5"
        style={{
          borderTop: `2px solid ${
            integrations.length > 0 ? 'var(--ok-ink)' : 'var(--info-ink)'
          }`,
        }}
      >
        <div>
          <div className="section-head mb-3">
            <h2 className="section-title">Gmail</h2>
            <span className="micro-label font-tabular">gmail.send only</span>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            Recipients will see this address as the sender. The app only requests
            permission to send mail; it never reads your inbox.
          </p>
        </div>

        {integrations && integrations.length > 0 ? (
          <div className="space-y-2.5">
            {integrations.map((i) => (
              <ConnectedRow key={i.id} i={i} />
            ))}
            <p className="text-[11.5px] italic" style={{ color: 'var(--ink-3)' }}>
              The most recently connected mailbox is used for sends.
            </p>
          </div>
        ) : (
          <p className="empty-note">No mailbox connected yet.</p>
        )}

        <a href="/api/integrations/google/start" className="btn-primary inline-block">
          Connect a Gmail mailbox
        </a>
      </section>

      {(outlookEnabled || outlookIntegrations.length > 0) && (
        <section
          className="card-soft p-6 space-y-5 mt-5"
          style={{
            borderTop: `2px solid ${
              outlookIntegrations.length > 0 ? 'var(--ok-ink)' : 'var(--info-ink)'
            }`,
          }}
        >
          <div>
            <div className="section-head mb-3">
              <h2 className="section-title">Outlook</h2>
              <span className="micro-label font-tabular">send only</span>
            </div>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
              Send from your Microsoft 365 / Outlook mailbox. Recipients will see this
              address as the sender. The app only requests permission to send mail; it
              never reads your inbox.
            </p>
          </div>

          {outlookIntegrations.length > 0 ? (
            <div className="space-y-2.5">
              {outlookIntegrations.map((i) => (
                <ConnectedRow key={i.id} i={i} />
              ))}
              <p className="text-[11.5px] italic" style={{ color: 'var(--ink-3)' }}>
                The most recently connected mailbox is used for sends.
              </p>
            </div>
          ) : (
            <p className="empty-note">No Outlook mailbox connected yet.</p>
          )}

          <a href="/api/integrations/microsoft/start" className="btn-primary inline-block">
            Connect Outlook
          </a>
        </section>
      )}

      <section
        className="card-soft p-6 space-y-5 mt-5"
        style={{
          borderTop: `2px solid ${
            driveIntegrations.length > 0 ? 'var(--ok-ink)' : 'var(--info-ink)'
          }`,
        }}
      >
        <div>
          <div className="section-head mb-3">
            <h2 className="section-title">Google Drive</h2>
            <span className="micro-label font-tabular">own files only</span>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            Connect your Google Drive and new lead sheets are saved there in your
            own &ldquo;Capricorn Leads&rdquo; spreadsheet. The app can only see and edit
            files it creates; it never touches the rest of your Drive.
          </p>
        </div>

        {driveIntegrations.length > 0 ? (
          <div className="space-y-2.5">
            {driveIntegrations.map((i) => (
              <ConnectedRow key={i.id} i={i} />
            ))}
            <p className="text-[11.5px] italic" style={{ color: 'var(--ink-3)' }}>
              The most recently connected Drive receives your lead sheets.
            </p>
          </div>
        ) : (
          <p className="empty-note">
            No Drive connected. Sheets are saved to the operator&rsquo;s Drive until you connect yours.
          </p>
        )}

        <a
          href="/api/integrations/google/start?provider=google_drive"
          className="btn-primary inline-block"
        >
          Connect Google Drive
        </a>
      </section>
    </div>
  );
}
