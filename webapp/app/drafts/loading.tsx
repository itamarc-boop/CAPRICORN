const ROW_WIDTHS = ['w-3/4', 'w-3/5', 'w-4/5', 'w-1/2', 'w-2/3', 'w-3/5'];

export default function DraftsLoading() {
  return (
    <div>
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        {/* Header */}
        <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
          <div className="skel w-32 h-8" />
          <div className="skel mt-2 w-72 h-3" />
        </div>

        {/* Status pills row */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skel w-20 h-6 rounded-full" />
          ))}
        </div>

        {/* Queue rows */}
        <div className="card-soft">
          {ROW_WIDTHS.map((width, i) => (
            <div
              key={i}
              className="px-4 py-3.5"
              style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
            >
              <div className={`skel h-4 ${width}`} />
              <div className="skel mt-1.5 h-3 w-2/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
