'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import {
  CATEGORY_LABELS,
  runSearch,
  type SearchCategory,
  type SearchResult,
} from '@/application/search';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  SectionHeading,
  type IconName,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { cn } from '@/lib/cn';

const CATEGORY_ICONS: Record<SearchCategory, IconName> = {
  job: 'jobs',
  customer: 'customers',
  site: 'pin',
  machine: 'machines',
  technician: 'user',
  document: 'library',
};

const CATEGORY_ORDER: readonly SearchCategory[] = [
  'job',
  'customer',
  'machine',
  'site',
  'technician',
  'document',
];

const EXAMPLES = [
  'EJE-1048',
  'ABC Engineering',
  'LW-V40-70214',
  'PO-88123',
  'spindle',
  'Leadwell',
];

const SearchPageContent = () => {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('q') ?? '';
  const [term, setTerm] = useState(initial);
  const [category, setCategory] = useState<SearchCategory | 'all'>('all');

  // Scoped by the actor inside `runSearch`, not by anything on this screen.
  const query = useQuery(`search:${currentUser.id}:${initial}`, (repos) =>
    runSearch(repos, currentUser, initial),
  );

  const grouped = useMemo(() => {
    const results = (query.data ?? []).filter(
      (result) => category === 'all' || result.category === category,
    );
    return CATEGORY_ORDER.map((key) => ({
      key,
      results: results.filter((result) => result.category === key),
    })).filter((group) => group.results.length > 0);
  }, [query.data, category]);

  const total = query.data?.length ?? 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = term.trim();
    router.push(trimmed.length === 0 ? '/search' : `/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <>
      <PageHeader
        title="Search"
        breadcrumbs={[{ label: 'Search' }]}
        description="Search across jobs, customers, sites, machines, serial numbers, technicians and the Technical Library."
      />

      <Card className="mb-5">
        <form onSubmit={submit}>
          <label htmlFor="global-search" className="mb-1.5 block text-sm font-semibold text-steel-700">
            Search the system
          </label>
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-steel-400"
            />
            <input
              id="global-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Job number, customer, serial number, order number, fault…"
              autoComplete="off"
              className="h-14 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface pr-4 pl-12 text-base placeholder:text-steel-400 hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
            />
          </div>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-steel-500">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setTerm(example);
                router.push(`/search?q=${encodeURIComponent(example)}`);
              }}
              className="rounded-full bg-steel-100 px-2.5 py-1 font-mono text-xs text-steel-600 transition-colors hover:bg-steel-200"
            >
              {example}
            </button>
          ))}
        </div>
      </Card>

      {initial.length === 0 ? (
        <EmptyState
          title="Start typing to search"
          description="Results are grouped by what they are, so a serial number and a job number never look the same."
          icon={<Icon name="search" />}
        />
      ) : query.error !== null ? (
        <ErrorState message={query.error} onRetry={query.refetch} />
      ) : query.loading ? (
        <LoadingPanel rows={4} label="Searching" />
      ) : total === 0 ? (
        <EmptyState
          title={`No results for "${initial}"`}
          description="Check the spelling, or try part of a serial number, customer name or job number."
          icon={<Icon name="search" />}
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <FilterChip
              active={category === 'all'}
              onClick={() => setCategory('all')}
              label={`All results (${total})`}
            />
            {CATEGORY_ORDER.map((key) => {
              const count = (query.data ?? []).filter((result) => result.category === key).length;
              if (count === 0) return null;
              return (
                <FilterChip
                  key={key}
                  active={category === key}
                  onClick={() => setCategory(key)}
                  label={`${CATEGORY_LABELS[key]} (${count})`}
                />
              );
            })}
          </div>

          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.key}>
                <SectionHeading
                  title={CATEGORY_LABELS[group.key]}
                  description={`${group.results.length} ${group.results.length === 1 ? 'result' : 'results'}`}
                  className="mb-3"
                />
                <ul className="space-y-2">
                  {group.results.map((result) => (
                    <li key={`${result.category}-${result.id}`}>
                      <ResultRow result={result} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
};

const FilterChip = ({
  active,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      'min-h-9 rounded-full px-3.5 text-sm font-semibold transition-colors',
      active
        ? 'bg-steel-900 text-white'
        : 'bg-surface text-steel-600 ring-1 ring-steel-300 ring-inset hover:bg-steel-50',
    )}
  >
    {label}
  </button>
);

const ResultRow = ({ result }: { readonly result: SearchResult }) => (
  <Link
    href={result.href}
    className="flex items-start gap-3 rounded-[var(--radius-card)] border border-steel-200 bg-surface p-4 transition-shadow hover:shadow-[var(--shadow-raised)]"
  >
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-steel-100 text-steel-500">
      <Icon name={CATEGORY_ICONS[result.category]} className="size-5" />
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-steel-900">{result.title}</p>
        <Badge tone="outline" size="sm">
          Matched {result.matchedOn.toLowerCase()}
        </Badge>
      </div>
      <p className="mt-0.5 truncate text-sm text-steel-600">{result.subtitle}</p>
      <p className="mt-1 line-clamp-2 text-sm text-steel-500">{result.detail}</p>
    </div>
    <Icon name="chevronRight" className="mt-2 size-4 shrink-0 text-steel-300" />
  </Link>
);

const SearchPage = () => (
  <Suspense fallback={<LoadingPanel rows={4} label="Loading search" />}>
    <SearchPageContent />
  </Suspense>
);

export default SearchPage;
