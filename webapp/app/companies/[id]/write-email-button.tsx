'use client';

/**
 * Hero "Write email" action. Unlike the old `href="#draft"` anchor (which just
 * scrolled and read as broken), this scrolls the email panel into view AND
 * focuses the subject field — a real action where the eye already is.
 */
export default function WriteEmailButton() {
  function open() {
    const section = document.getElementById('email');
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Focus after the scroll settles so it doesn't fight the smooth scroll.
    window.setTimeout(() => {
      const subject = document.getElementById('compose-subject') as HTMLInputElement | null;
      subject?.focus({ preventScroll: true });
    }, 350);
  }

  return (
    <button type="button" onClick={open} className="btn-primary text-[13px] inline-flex items-center">
      Write email
    </button>
  );
}
