'use client';
import { useEffect } from 'react';

/**
 * Route-level error boundary. Without this, any thrown server error — most
 * commonly requireAppUser() rejecting a signed-in-but-not-allowlisted user
 * (lib/auth/allowlist.ts) — renders Next's unstyled default crash screen.
 * Renders inside the root layout, so the app chrome (or the minimal signed-in
 * shell for a denied user) still frames it.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const denied = /not on the Capricorn allowlist/i.test(error.message);

  useEffect(() => {
    // Keep the raw error in the console for debugging; the UI stays friendly.
    console.error(error);
  }, [error]);

  if (denied) {
    return (
      <div className="mx-auto max-w-sm mt-24 text-center">
        <h1
          className="font-display text-[28px] leading-tight"
          style={{ color: 'var(--navy-deep)' }}
        >
          Not on the allowlist
        </h1>
        <p className="text-[13px] mt-3" style={{ color: 'var(--ink-3)' }}>
          You’re signed in, but this account isn’t approved for Capricorn Lead
          Ops. Sign out and use a different account, or ask an admin to add you.
        </p>
        <a href="/auth/signout" className="btn-primary inline-block mt-6">
          Sign out
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm mt-24 text-center">
      <h1
        className="font-display text-[28px] leading-tight"
        style={{ color: 'var(--navy-deep)' }}
      >
        Something went wrong
      </h1>
      <p className="text-[13px] mt-3" style={{ color: 'var(--ink-3)' }}>
        An unexpected error interrupted this page. You can try again — if it
        keeps happening, let an admin know.
      </p>
      <div className="flex items-center justify-center gap-2 mt-6">
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
        <a href="/" className="btn-ghost">
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
