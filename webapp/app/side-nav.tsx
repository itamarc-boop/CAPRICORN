'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Primary navigation, shared between the desktop sidebar (SideNav) and the
 * small-screen horizontal strip in the top bar (MobileNav). Client component
 * only because active-state needs usePathname.
 */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function IconHouse() {
  return (
    <svg {...iconProps}>
      <path d="M2.5 7.4 8 2.8l5.5 4.6" />
      <path d="M4 6.6V13.2h8V6.6" />
      <path d="M6.7 13.2v-3h2.6v3" />
    </svg>
  );
}

function IconCompass() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="6" />
      <path d="m10.4 5.6-1.1 3.7-3.7 1.1 1.1-3.7z" />
    </svg>
  );
}

function IconBuilding() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="2.5" width="10" height="11" rx="1" />
      <path d="M5.8 5.2h.01M8 5.2h.01M10.2 5.2h.01M5.8 7.6h.01M8 7.6h.01M10.2 7.6h.01" />
      <path d="M6.8 13.5V10.8h2.4v2.7" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="3.5" width="12" height="9" rx="1" />
      <path d="m2.6 4.6 5.4 4 5.4-4" />
    </svg>
  );
}

function IconFileText() {
  return (
    <svg {...iconProps}>
      <path d="M9.5 1.8h-5a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.8z" />
      <path d="M9.5 1.8v3h3" />
      <path d="M5.8 8.2h4.4M5.8 10.6h3.2" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg {...iconProps}>
      <path d="M5.6 1.8v3.4M10.4 1.8v3.4" />
      <path d="M4 5.2h8v2.4a4 4 0 0 1-8 0z" />
      <path d="M8 11.6v2.6" />
    </svg>
  );
}

const NAV_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: React.ReactNode;
}> = [
  { href: '/', label: 'Dashboard', icon: <IconHouse /> },
  { href: '/discover', label: 'Discover', icon: <IconCompass /> },
  { href: '/companies', label: 'Companies', icon: <IconBuilding /> },
  { href: '/drafts', label: 'Drafts', icon: <IconMail /> },
  { href: '/templates', label: 'Templates', icon: <IconFileText /> },
  { href: '/integrations', label: 'Integrations', icon: <IconPlug /> },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Vertical nav list for the fixed navy sidebar (desktop). */
export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-3" aria-label="Primary">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`relative flex items-center gap-2.5 rounded px-3 py-2 text-[13px] transition-colors ${
              active
                ? 'bg-white/12 text-white'
                : 'text-white/65 hover:bg-white/8 hover:text-white'
            }`}
          >
            {active ? (
              <span
                aria-hidden
                className="absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-full"
                style={{ background: 'var(--t2-bg)' }}
              />
            ) : null}
            <span className={`shrink-0 ${active ? 'opacity-95' : 'opacity-75'}`}>
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Horizontal scrolling nav strip for the top bar on small screens. */
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      className="flex items-center gap-1 overflow-x-auto"
      aria-label="Primary"
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] transition-colors ${
              active ? '' : 'text-[color:var(--ink-3)] hover:text-[color:var(--ink)]'
            }`}
            style={
              active
                ? { background: 'var(--t1-bg)', color: 'var(--t1-ink)' }
                : undefined
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
