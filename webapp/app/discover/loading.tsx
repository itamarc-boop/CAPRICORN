export default function DiscoverLoading() {
  return (
    <div>
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        {/* Header */}
        <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
          <div className="skel w-44 h-8" />
          <div className="skel mt-2 w-80 h-3" />
        </div>

        <div className="space-y-5">
          {/* Form card */}
          <div className="card-soft p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <div>
                <div className="skel w-16 h-2.5 mb-1.5" />
                <div className="skel h-8 w-full" />
              </div>
              <div>
                <div className="skel w-20 h-2.5 mb-1.5" />
                <div className="skel h-8 w-28" />
              </div>
              <div className="skel h-8 w-32" />
            </div>
            <div className="skel mt-3 h-3 w-72" />
          </div>

          {/* Run rows */}
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-soft p-4">
                <div className="flex items-center gap-3">
                  <div className="skel h-4 w-28" />
                  <div className="skel h-5 w-20 rounded-full" />
                  <div className="skel h-3 w-24 ml-auto" />
                </div>
                <div className="mt-3 flex gap-6">
                  <div className="skel h-7 w-16" />
                  <div className="skel h-7 w-16" />
                  <div className="skel h-7 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
