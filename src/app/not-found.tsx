'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The application's own 404.
 *
 * Next's default 404 says "This page could not be found" and nothing else,
 * which is indistinguishable from a broken deployment. During a demonstration
 * that is the worst possible answer: nobody can tell whether the route is
 * missing from the code or missing from the build being served.
 *
 * So this page names the path that failed, says plainly that the most common
 * cause is a stale build, and offers the routes that do exist. Client component
 * because it reads the path it was reached by.
 */
const NotFound = () => {
  const pathname = usePathname();

  return (
    <main className="mx-auto flex min-h-dvh max-w-[42rem] flex-col justify-center px-6 py-16">
      <p className="font-mono text-sm font-semibold tracking-wide text-eje-600">ERROR 404</p>
      <h1 className="mt-2 text-3xl font-semibold text-steel-900">This page does not exist</h1>

      <p className="mt-4 text-sm leading-relaxed text-steel-600">
        Nothing in the EJE Job Card System is served at:
      </p>
      <p className="mt-2 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3.5 py-2.5 font-mono text-sm break-all text-steel-800">
        {pathname}
      </p>

      <div className="mt-6 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-4 py-3.5">
        <p className="text-sm font-semibold text-amber-eje-800">
          Seeing this on a route that should work?
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-amber-eje-700">
          The usual cause is a stale server: a previously started
          <span className="font-mono"> next </span>
          process, or a <span className="font-mono">.next</span> build from an older commit, still
          answering on this port. Stop every Node process, delete{' '}
          <span className="font-mono">.next</span>, then start the application again — or run{' '}
          <span className="font-mono">npm run redeploy</span>, which does exactly that and then
          checks every route.
        </p>
      </div>

      <nav className="mt-8">
        <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
          Where you probably meant to go
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            { href: '/dashboard', label: 'Dashboard' },
            { href: '/jobs', label: 'Jobs' },
            { href: '/jobs/closed', label: 'Closed Jobs' },
            { href: '/calendar', label: 'Calendar' },
            { href: '/messages', label: 'Messages' },
            { href: '/notifications', label: 'Notifications' },
            { href: '/customers', label: 'Customers' },
            { href: '/admin', label: 'Administration' },
          ].map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex min-h-11 items-center justify-between rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3.5 text-sm font-medium text-steel-800 transition-colors hover:border-eje-400 hover:text-eje-700"
              >
                {item.label}
                <span className="font-mono text-xs text-steel-400">{item.href}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
};

export default NotFound;
