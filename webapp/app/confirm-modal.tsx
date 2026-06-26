'use client';
import { useEffect, useId, useRef } from 'react';

/**
 * Shared confirm dialog. Replaces the hand-rolled `fixed inset-0` overlays
 * (which had no dialog semantics, Escape, focus trap, or backdrop dismiss) and
 * the off-brand native window.confirm() deletes. One scrim definition lives
 * here, so the three copies of the magic rgba are gone too.
 *
 * Accessibility: role="dialog" + aria-modal, labelled by the title, focus moves
 * to the confirm button on open and is restored on close, Tab is trapped inside,
 * Escape and a backdrop click both cancel (disabled while `busy`).
 */
export default function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  busy = false,
  tone = 'primary',
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** 'danger' tints the confirm button with the warn token for destructive actions. */
  tone?: 'primary' | 'danger';
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on open; restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => prev?.focus?.();
  }, [open]);

  // Escape cancels; Tab is trapped within the card.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(15, 46, 58, 0.35)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="card-soft rise-in w-full max-w-md p-5"
      >
        <div id={titleId} className="micro-label mb-2">
          {title}
        </div>
        <div className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
          {children}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn-ghost text-[13px]"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="btn-primary text-[13px]"
            style={tone === 'danger' ? { background: 'var(--danger-ink)', color: 'var(--surface)' } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
