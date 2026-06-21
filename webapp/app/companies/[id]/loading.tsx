const TEXT_WIDTHS = ['w-[95%]', 'w-[80%]', 'w-[60%]'];

export default function CompanyDetailLoading() {
  return (
    <div className="space-y-6">
      <span className="sr-only">Loading…</span>

      {/* Hero */}
      <header className="card-soft p-6" aria-hidden="true">
        <div className="skel w-32 h-3" />
        <div className="skel mt-2.5 w-72 h-8" />
        <div className="skel mt-2 w-48 h-4" />

        {/* Stat band */}
        <div
          className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px rounded-[5px] overflow-hidden border"
          style={{ borderColor: 'var(--line-soft)', background: 'var(--line-soft)' }}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="px-4 py-3 min-w-0" style={{ background: 'var(--surface)' }}>
              <div className="skel w-16 h-3 mb-1.5" />
              <div className="skel w-12 h-6" />
            </div>
          ))}
        </div>
      </header>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start" aria-hidden="true">
        <div className="lg:col-span-2 space-y-5">
          {[0, 1, 2].map((i) => (
            <section key={i} className="card-soft p-5">
              <div className="skel w-36 h-4 mb-3.5" />
              <div className="space-y-2.5">
                {TEXT_WIDTHS.map((width) => (
                  <div key={width} className={`skel h-3.5 ${width}`} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="space-y-5">
          {[0, 1, 2].map((i) => (
            <section key={i} className="card-soft p-5">
              <div className="skel w-28 h-4 mb-3.5" />
              <div className="skel h-3.5 w-[85%]" />
              <div className="skel mt-2.5 h-3.5 w-[65%]" />
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}
