export default function DashboardLoading() {
  return (
    <div>
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        {/* Header */}
        <div
          className="flex items-end justify-between mb-6 pb-5 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <div>
            <div className="skel w-40 h-8" />
            <div className="skel mt-2 w-64 h-3" />
          </div>
          <div className="skel w-28 h-4" />
        </div>

        {/* Funnel row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="card-soft p-4">
              <div className="skel w-12 h-7" />
              <div className="mt-2.5">
                <div className="skel w-20 h-5 rounded-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Secondary strip */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-soft p-4">
              <div className="skel w-24 h-3" />
              <div className="skel mt-1.5 w-10 h-6" />
            </div>
          ))}
        </div>
        <div className="skel mt-2.5 w-40 h-3" />

        {/* Recent sends / Recently added */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-5">
          {[0, 1].map((col) => (
            <section key={col}>
              <div className="skel w-32 h-5" />
              <div className="card-soft mt-3">
                {[0, 1, 2, 3].map((row) => (
                  <div
                    key={row}
                    className="px-4 py-3"
                    style={row > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className={`skel h-4 ${row % 2 === 0 ? 'w-3/4' : 'w-1/2'}`} />
                        <div className="skel mt-1.5 h-3 w-2/5" />
                      </div>
                      <div className="skel h-3 w-10 shrink-0" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Markets */}
        <div className="mt-10">
          <div
            className="flex items-end justify-between pb-3 border-b"
            style={{ borderColor: 'var(--line)' }}
          >
            <div className="skel w-24 h-5" />
            <div className="skel w-16 h-3" />
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-soft p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="skel w-28 h-5" />
                  <div className="skel w-8 h-4" />
                </div>
                <div className="skel mt-3 h-1.5 w-full rounded-full" />
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <div className="skel w-16 h-5 rounded-full" />
                  <div className="skel w-20 h-5 rounded-full" />
                  <div className="skel w-14 h-5 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
