'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The four surfaces, in the order a buyer meets them.
 *
 * There was no navigation at all: the pages existed and you reached them by
 * typing the URL, which is fine for a reviewer with a link list and useless for
 * anyone else. The labels say what each page answers rather than what it is
 * called internally -- "Evidence" beats "operations" for a reader who does not
 * already know the system.
 */
const PAGES = [
  { href: '/', label: 'Search', hint: 'Ask in plain English' },
  { href: '/shortlist', label: 'Shortlist', hint: 'Filter and rank firms' },
  { href: '/agent', label: 'Agent', hint: 'Multi-step questions' },
  { href: '/operations', label: 'Evidence', hint: 'What ran, and what was refused' },
];

export default function Nav() {
  const path = usePathname();

  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-inner">
        <Link href="/" className="nav-brand">Sightline</Link>
        <ul className="nav-links">
          {PAGES.map((p) => {
            // Exact match for the root, prefix match elsewhere, so a future
            // detail route under /shortlist still highlights its parent.
            const active = p.href === '/' ? path === '/' : path.startsWith(p.href);
            return (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className={active ? 'nav-link is-active' : 'nav-link'}
                  aria-current={active ? 'page' : undefined}
                  title={p.hint}
                >
                  {p.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
