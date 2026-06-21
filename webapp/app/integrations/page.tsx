import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type SearchParams = { status?: string; detail?: string };

export default async function IntegrationsPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  await requireAppUser();
  const sp = await searchParams;
  const supabase = await getServerSupabase();
  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, provider, account_email, created_at, last_used_at, scope')
    .eq('provider', 'gmail')
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-2xl">
      <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <h1
          className="font-display text-[34px] leading-none"
          style={{ color: 'var(--navy-deep)' }}
        >
          Integrations
        </h1>
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          Connect the Capricorn mailbox you want outbound emails sent from.
        </p>
      </div>

      {sp?.status === 'ok' && (
        <div
          className="mb-5 rounded px-3.5 py-2.5 text-[13px]"
          style={{ background: 'var(--ok-bg)', color: 'var(--ok-ink)' }}
        >
          Connected: <span className="font-tabular">{sp.detail}</span>
        </div>
      )}
      {sp?.status === 'error' && (
        <div
          className="mb-5 rounded px-3.5 py-2.5 text-[13px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          Could not connect: {sp.detail}
        </div>
      )}

      <section className="card-soft p-6 space-y-5">
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="font-display text-[17px]" style={{ color: 'var(--navy-deep)' }}>
              Gmail
            </h2>
            <span
              className="font-tabular text-[10.5px] uppercase tracking-wider"
              style={{ color: 'var(--ink-4)' }}
            >
              gmail.send only
            </span>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            Recipients will see this address as the sender. The app only requests
            permission to send mail; it never reads your inbox.
          </p>
        </div>

        {integrations && integrations.length > 0 ? (
          <div className="space-y-2.5">
            {integrations.map(i => (
              <div
                key={i.id}
                className="rounded px-3.5 py-2.5"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
              >
                <div className="font-tabular text-[13px]" style={{ color: 'var(--ink)' }}>
                  {i.account_email}
                </div>
                <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                  Connected {new Date(i.created_at).toLocaleString()}
                  {i.last_used_at && ` · last used ${new Date(i.last_used_at).toLocaleString()}`}
                </div>
              </div>
            ))}
            <p className="text-[11.5px] italic" style={{ color: 'var(--ink-3)' }}>
              The most recently connected mailbox is used for sends.
            </p>
          </div>
        ) : (
          <p className="text-[13px] italic" style={{ color: 'var(--ink-3)' }}>
            No mailbox connected yet.
          </p>
        )}

        <a href="/api/integrations/google/start" className="btn-primary inline-block">
          Connect a Gmail mailbox
        </a>
      </section>
    </div>
  );
}
