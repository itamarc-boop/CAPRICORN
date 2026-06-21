const ROW_WIDTHS = ['w-3/4', 'w-2/3', 'w-4/5', 'w-1/2', 'w-3/5', 'w-3/4', 'w-2/5', 'w-2/3'];

export default function CompaniesLoading() {
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
            <div className="skel w-48 h-8" />
            <div className="skel mt-2 w-72 h-3" />
          </div>
          <div className="skel w-16 h-4" />
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="skel w-36 h-8" />
          <div className="skel w-36 h-8" />
          <div className="skel w-36 h-8" />
        </div>

        {/* Table */}
        <div className="card-soft overflow-hidden">
          <div
            className="px-4 py-3 border-b"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}
          >
            <div className="skel h-3 w-1/3" />
          </div>
          {ROW_WIDTHS.map((width, i) => (
            <div
              key={i}
              className="px-4 py-3.5"
              style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
            >
              <div className={`skel h-4 ${width}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
