import type { Metadata } from 'next';
import Link from 'next/link';
import { getCurrentAppUser } from '@/lib/auth/allowlist';
import { displaySerif, bodySans, tabularMono } from './fonts';
import { SideNav, MobileNav } from './side-nav';
import GlobalSearch from './global-search';
import './globals.css';

export const metadata: Metadata = {
  title: 'Capricorn Lead Ops',
  description: 'Internal lead-management dashboard for Capricorn.',
};

export default async function RootLayout({
  children,
}: { children: React.ReactNode }) {
  const user = await getCurrentAppUser();

  return (
    <html
      lang="en"
      className={`${displaySerif.variable} ${bodySans.variable} ${tabularMono.variable}`}
    >
      <body className="min-h-screen">
        {!user ? (
          // Signed-out (login) — minimal centered column on the ivory ground.
          <main>{children}</main>
        ) : (
          <>
            {/* Fixed navy sidebar — desktop only. */}
            <aside
              className="fixed inset-y-0 left-0 z-50 hidden w-[230px] flex-col overflow-y-auto lg:flex"
              style={{ background: 'var(--navy-deep)' }}
            >
              <div className="px-5 pb-4 pt-5">
                <Link href="/" className="block leading-tight">
                  <span className="font-display text-[18px] tracking-tight text-white">
                    Capricorn
                  </span>
                  <span className="block font-display text-[12.5px] italic text-white/50">
                    Lead Ops
                  </span>
                </Link>
              </div>

              <SideNav />

              <div className="flex-1" aria-hidden />

              <div className="border-t border-white/10 px-5 py-4">
                <p className="break-all text-[11px] leading-snug text-white/40">
                  {user.email}
                  <span className="block">{user.role}</span>
                </p>
                <form action="/auth/signout" method="post" className="contents">
                  <button
                    type="submit"
                    className="mt-2 text-[12px] text-white/55 hover:text-white transition-colors cursor-pointer"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </aside>

            {/* Content column. */}
            <div className="lg:pl-[230px]">
              <header className="topbar-glass sticky top-0 z-40">
                <div className="flex items-center gap-4 px-6 py-2.5">
                  <GlobalSearch />
                </div>
                <div className="px-6 pb-2 lg:hidden">
                  <MobileNav />
                </div>
              </header>
              <main className="mx-auto max-w-[1200px] px-6 py-6">
                {children}
              </main>
            </div>
          </>
        )}
      </body>
    </html>
  );
}
