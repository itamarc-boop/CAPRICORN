'use client';

/**
 * Last-resort boundary for errors thrown in the ROOT layout itself (where the
 * normal error.tsx can't help). It replaces <html>/<body> and the CSS layer,
 * so the design tokens aren't available here — the palette is inlined as the
 * one justified exception to the "tokens only" rule (this is the crash frame).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100vh',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#F8F4EC',
          color: '#1B1D1C',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 360, padding: 24 }}>
          <h1 style={{ fontSize: 24, color: '#0F2E3A', margin: '0 0 8px' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#6E6A60', margin: '0 0 20px' }}>
            The app hit an unexpected error. Reload to try again.
          </p>
          <button
            onClick={reset}
            style={{
              background: '#1F4E5F',
              color: '#fff',
              border: 'none',
              borderRadius: 5,
              padding: '8px 16px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
