'use client';

import { useMemo, useState } from 'react';
import {
  can,
  type DocumentTextIndex,
  type TechnicalDocument,
  type TechnicalDocumentType,
} from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LoadingPanel,
  Modal,
  QueryFailure,
  SectionHeading,
  SelectField,
  Tabs,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { UploadDocumentDialog } from '@/components/library/UploadDocumentDialog';
import type { LibrarySearchPage } from '@/application/library-search';
import { library, reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatFileSize } from '@/lib/format';
import { cn } from '@/lib/cn';

const TYPE_LABELS: Record<TechnicalDocumentType, string> = {
  machine_manual: 'Machine Manual',
  electrical_diagram: 'Electrical Diagram',
  service_manual: 'Service Manual',
  safety_procedure: 'Safety Procedure',
  work_procedure: 'Work Procedure',
  datasheet: 'Datasheet',
};

type TabId = 'all' | 'favourites' | 'recent';

const LibraryPage = () => {
  const user = useCurrentUser();

  const [tab, setTab] = useState<TabId>('all');
  const [term, setTerm] = useState('');
  const [type, setType] = useState<TechnicalDocumentType | 'all'>('all');
  const [manufacturer, setManufacturer] = useState('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [preview, setPreview] = useState<TechnicalDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Which page of the inside-the-documents results is showing. LIB-5. */
  const [textPage, setTextPage] = useState(1);
  // A Master reviews pending uploads in Administration; a technician must not
  // see them here, or an unapproved document could be followed on site.
  const seesPending = can(user.role, 'library.manage');

  const query = useQuery(`library:${user.id}`, () => reads.library());

  const documents = useMemo(() => query.data?.documents ?? [], [query.data]);
  /** Which documents hold searchable text, by document id. LIB-5. */
  const indexes = useMemo(
    () => new Map((query.data?.indexes ?? []).map((index) => [index.documentId, index])),
    [query.data],
  );

  /*
   * SEARCHING INSIDE THE DOCUMENTS. MASTER SCOPE LIB-5.
   *
   * A SECOND READ, not a filter over the first. The list above matches the
   * fields somebody typed into the upload form — the name, the model, the tags
   * — and that is a useful way to find a manual you already know about. This
   * one asks the server for the documents whose TEXT contains the words, which
   * is what a technician with an alarm code in front of them is actually
   * asking. Both are shown, because they answer different questions.
   *
   * The server decides what may be searched and refuses a query that is too
   * short; the screen does not pre-judge either, beyond not asking at all
   * while the box is empty.
   */
  const insideTerm = term.trim();
  const inside = useQuery(
    `library:text:${user.id}:${insideTerm.toLowerCase()}:${textPage}`,
    () => (insideTerm.length >= 2 ? reads.librarySearch(insideTerm, textPage) : Promise.resolve(null)),
  );
  const favourites = useMemo(() => query.data?.favourites ?? [], [query.data]);
  const recent = useMemo(() => query.data?.recent ?? [], [query.data]);

  const manufacturers = useMemo(
    () => [...new Set(documents.map((document) => document.manufacturer))].sort(),
    [documents],
  );

  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const base =
      tab === 'favourites'
        ? documents.filter((document) => favourites.includes(document.id))
        : tab === 'recent'
          ? recent
              .map((id) => documents.find((document) => document.id === id))
              .filter((document): document is TechnicalDocument => document !== undefined)
          : documents;

    return base
      .filter((document) => seesPending || document.status !== 'pending_approval')
      .filter((document) => includeArchived || document.status !== 'archived')
      .filter((document) => type === 'all' || document.documentType === type)
      .filter((document) => manufacturer === 'all' || document.manufacturer === manufacturer)
      .filter(
        (document) =>
          needle.length === 0 ||
          document.name.toLowerCase().includes(needle) ||
          document.description.toLowerCase().includes(needle) ||
          document.machineModel.toLowerCase().includes(needle) ||
          document.manufacturer.toLowerCase().includes(needle) ||
          document.tags.some((tag) => tag.toLowerCase().includes(needle)),
      );
  }, [documents, favourites, recent, seesPending, tab, term, type, manufacturer, includeArchived]);

  const openDocument = async (document: TechnicalDocument) => {
    setPreview(document);
    await library.recordView(document.id);
  };

  const toggleFavourite = async (document: TechnicalDocument) => {
    await library.toggleFavourite(document.id);
    query.refetch();
  };

  if (query.error !== null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Technical Library"
        breadcrumbs={[{ label: 'Technical Library' }]}
        description="Manuals, diagrams and procedures, available on site. Only current documents are shown by default."
        actions={
          <Button
            variant="secondary"
            leadingIcon={<Icon name="plus" className="size-4" />}
            onClick={() => setUploading(true)}
          >
            Upload document
          </Button>
        }
      />

      <UploadDocumentDialog
        open={uploading}
        onClose={() => setUploading(false)}
        /*
          REFRESH, DO NOT CLOSE. The dialog reports whether the document it just
          uploaded can be searched, and closing it over that message would hide
          the one fact the person who uploaded it needs.
        */
        onUploaded={() => query.refetch()}
      />

      <Card className="mb-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label
              htmlFor="library-search"
              className="mb-1.5 block text-sm font-semibold text-steel-700"
            >
              Search the library
            </label>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-steel-400"
              />
              <input
                id="library-search"
                type="search"
                value={term}
                onChange={(event) => {
                  setTerm(event.target.value);
                  // A new search starts at its first page, not wherever the
                  // last one was left.
                  setTextPage(1);
                }}
                placeholder="Document name, machine model, tag — or words inside the documents"
                className="h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface pr-3 pl-10 text-sm placeholder:text-steel-400 hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
              />
            </div>
          </div>
          <SelectField
            label="Document type"
            value={type}
            onChange={(event) => setType(event.target.value as TechnicalDocumentType | 'all')}
            options={[
              { value: 'all', label: 'All types' },
              ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
          <SelectField
            label="Manufacturer"
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
            options={[
              { value: 'all', label: 'All manufacturers' },
              ...manufacturers.map((value) => ({ value, label: value })),
            ]}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-steel-100 pt-4">
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-steel-700">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
            />
            Include archived versions
          </label>
          <p className="tabular text-sm text-steel-500">
            {filtered.length} {filtered.length === 1 ? 'document' : 'documents'}
          </p>
        </div>
      </Card>

      {insideTerm.length >= 2 && (
        <InsideDocuments
          term={insideTerm}
          page={inside.data}
          loading={inside.loading}
          error={inside.error}
          onPage={setTextPage}
          onOpen={(hit: TechnicalDocument) => void openDocument(hit)}
        />
      )}

      <Tabs
        tabs={[
          { id: 'all', label: 'All documents' },
          {
            id: 'favourites',
            label: 'Favourites',
            badge:
              favourites.length > 0 ? (
                <Badge tone="neutral" size="sm">
                  {favourites.length}
                </Badge>
              ) : undefined,
          },
          { id: 'recent', label: 'Recently viewed' },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {query.loading ? (
        <LoadingPanel rows={4} label="Loading library" />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={tab === 'favourites' ? 'No favourites yet' : 'No documents found'}
          description={
            tab === 'favourites'
              ? 'Star the documents you use most and they will appear here for quick access on site.'
              : 'No document matches the current filters.'
          }
          icon={<Icon name="library" />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((document) => (
            <DocumentCard
              key={document.id}
              document={document}
              index={indexes.get(document.id) ?? null}
              favourite={favourites.includes(document.id)}
              onOpen={() => openDocument(document)}
              onToggleFavourite={() => toggleFavourite(document)}
            />
          ))}
        </div>
      )}

      <DocumentPreview document={preview} onClose={() => setPreview(null)} />
    </>
  );
};

/**
 * The documents whose TEXT contains the words. MASTER SCOPE LIB-5.
 *
 * Shown as its own section with the snippets in it, because a result that is
 * only a file name is a result nobody can judge: the technician wants to see
 * that the manual really does talk about the alarm before opening fourteen
 * megabytes of it on a tablet at a customer's site.
 *
 * WHAT IS NOT SEARCHABLE IS SAID HERE TOO. "Nothing matched" and "nothing
 * matched, and four manuals in this library are scans nobody can search" are
 * different answers, and only the second one is true when it is true.
 */
const InsideDocuments = ({
  term,
  page,
  loading,
  error,
  onPage,
  onOpen,
}: {
  readonly term: string;
  readonly page: LibrarySearchPage | null | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onPage: (page: number) => void;
  readonly onOpen: (document: TechnicalDocument) => void;
}) => {
  const pages = page === null || page === undefined ? 0 : Math.ceil(page.matched / page.pageSize);
  const unsearchable =
    page === null || page === undefined
      ? 0
      : page.notSearchable.needsOcr + page.notSearchable.failed + page.notSearchable.notIndexed;

  return (
    <Card className="mb-5">
      {/* The id goes on a plain element: `Card` renders a `<section>` and
          forwards only its own props, so a `data-` attribute put on it is
          dropped silently. */}
      <div data-testid="library-inside-results" />
      <CardHeader
        title="Found inside the documents"
        description={`The words of the documents themselves, not their file names. Searching for "${term}".`}
      />

      {loading && page === undefined ? (
        <LoadingPanel rows={2} label="Searching inside the documents" />
      ) : error !== null ? (
        /* The server's own refusal — a query too short, or a page that does
           not exist — in its own words. */
        <p className="px-4 pb-4 text-sm text-steel-600" data-testid="library-inside-refusal">
          {error}
        </p>
      ) : page === null || page === undefined ? null : (
        <div className="space-y-3 px-4 pb-4">
          <p className="tabular text-sm text-steel-500">
            {page.matched === 0
              ? 'No document contains all of those words.'
              : `${page.matched} document${page.matched === 1 ? '' : 's'} contain${page.matched === 1 ? 's' : ''} all of those words.`}
            {unsearchable > 0 && (
              <span>
                {' '}
                {unsearchable} document{unsearchable === 1 ? '' : 's'} in the library{' '}
                {unsearchable === 1 ? 'holds' : 'hold'} no searchable text, so{' '}
                {unsearchable === 1 ? 'it was' : 'they were'} not searched.
              </span>
            )}
          </p>

          {page.hits.map((hit) => (
            <div
              key={hit.document.id}
              className="rounded-[var(--radius-control)] border border-steel-200 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-steel-900">{hit.document.name}</p>
                  <p className="text-xs text-steel-500">
                    {hit.document.manufacturer} · {hit.document.machineModel} ·{' '}
                    {hit.document.version} · {hit.index.pages} pages
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => onOpen(hit.document)}>
                  Open
                </Button>
              </div>
              {hit.snippets.map((snippet) => (
                <p
                  key={snippet}
                  className="mt-2 border-l-2 border-eje-200 pl-3 text-sm leading-relaxed text-steel-700"
                >
                  {snippet}
                </p>
              ))}
            </div>
          ))}

          {pages > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-steel-100 pt-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={page.page <= 1}
                onClick={() => onPage(page.page - 1)}
              >
                Previous
              </Button>
              <p className="tabular text-xs text-steel-500">
                Page {page.page} of {pages}
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={page.page >= pages}
                onClick={() => onPage(page.page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

const STATUS_TONE = {
  current: 'green',
  archived: 'neutral',
  pending_approval: 'amber',
} as const;

const STATUS_LABEL = {
  current: 'Current',
  archived: 'Archived',
  pending_approval: 'Pending approval',
} as const;

/**
 * WHETHER A DOCUMENT CAN BE SEARCHED, ON THE DOCUMENT. MASTER SCOPE LIB-5.
 *
 * Said on every row rather than inferred from an empty result: a scanned manual
 * is a perfectly good document that no search will ever find, and a technician
 * who does not know that concludes EJE has nothing on the machine.
 */
const IndexBadge = ({ index }: { readonly index: DocumentTextIndex | null }) => {
  if (index === null) {
    return (
      <Badge tone="neutral" size="sm">
        Not indexed
      </Badge>
    );
  }
  if (index.state === 'indexed') {
    return (
      <Badge tone="green" size="sm">
        Searchable
      </Badge>
    );
  }
  return (
    <Badge tone="amber" size="sm">
      {index.state === 'needs_ocr' ? 'Not searchable — scanned' : 'Not searchable'}
    </Badge>
  );
};

const DocumentCard = ({
  document,
  index,
  favourite,
  onOpen,
  onToggleFavourite,
}: {
  readonly document: TechnicalDocument;
  readonly index: DocumentTextIndex | null;
  readonly favourite: boolean;
  readonly onOpen: () => void;
  readonly onToggleFavourite: () => void;
}) => (
  <Card className={cn('flex h-full flex-col', document.status === 'archived' && 'opacity-75')}>
    <div className="flex items-start gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-eje-50 text-eje-600">
        <Icon name="document" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm leading-snug font-semibold text-steel-900">{document.name}</h3>
        <p className="mt-0.5 text-xs text-steel-500">
          {document.manufacturer} · {document.machineModel}
        </p>
      </div>
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-label={favourite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={favourite}
        className={cn(
          'rounded-[var(--radius-control)] p-2 transition-colors',
          favourite
            ? 'text-amber-eje-500 hover:bg-amber-eje-50'
            : 'text-steel-300 hover:bg-steel-100 hover:text-steel-500',
        )}
      >
        <Icon name="star" filled={favourite} className="size-5" />
      </button>
    </div>

    <p className="mt-3 line-clamp-2 flex-1 text-sm leading-relaxed text-steel-600">
      {document.description}
    </p>

    <div className="mt-3 flex flex-wrap gap-1.5">
      <Badge tone="outline" size="sm">
        {TYPE_LABELS[document.documentType]}
      </Badge>
      <Badge tone={STATUS_TONE[document.status]} size="sm" dot>
        {STATUS_LABEL[document.status]}
      </Badge>
      <Badge tone="neutral" size="sm">
        {document.version}
      </Badge>
      <IndexBadge index={index} />
    </div>

    <div className="mt-4 flex items-center justify-between gap-2 border-t border-steel-100 pt-3">
      <p className="text-xs text-steel-400">
        {document.pageCount} pages · {formatFileSize(document.fileSizeBytes)} ·{' '}
        {formatDate(document.uploadedAt)}
      </p>
      <Button size="sm" variant="secondary" onClick={onOpen}>
        Open
      </Button>
    </div>
  </Card>
);

const DocumentPreview = ({
  document,
  onClose,
}: {
  readonly document: TechnicalDocument | null;
  readonly onClose: () => void;
}) => (
  <Modal
    open={document !== null}
    title={document?.name ?? ''}
    description={
      document === null
        ? undefined
        : `${document.manufacturer} ${document.machineModel} · ${document.version}`
    }
    onClose={onClose}
    size="xl"
    footer={
      <>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button leadingIcon={<Icon name="download" className="size-4" />} disabled>
          Download (simulated)
        </Button>
      </>
    }
  >
    {document !== null && (
      <div className="space-y-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="outline" size="sm">
            {TYPE_LABELS[document.documentType]}
          </Badge>
          <Badge tone={STATUS_TONE[document.status]} size="sm" dot>
            {STATUS_LABEL[document.status]}
          </Badge>
          {document.tags.map((tag) => (
            <Badge key={tag} tone="neutral" size="sm">
              {tag}
            </Badge>
          ))}
        </div>

        <p className="text-sm leading-relaxed text-steel-700">{document.description}</p>

        <SectionHeading title="Preview" className="!mb-0" />
        <div className="rounded-[var(--radius-card)] bg-steel-200/60 p-6">
          <div
            // A document preview represents paper, so it stays light in both themes.
            data-theme="light"
            className="mx-auto max-w-lg space-y-3 bg-white p-8 shadow-[var(--shadow-card)]"
          >
            <p className="text-[10px] font-semibold tracking-[0.2em] text-steel-400 uppercase">
              {document.manufacturer}
            </p>
            <p className="text-xl font-bold text-steel-900">{document.name}</p>
            <p className="text-xs text-steel-500">
              {document.machineModel} · {document.version}
            </p>
            <div className="space-y-2 pt-4">
              {Array.from({ length: 9 }, (_, index) => (
                <div
                  key={index}
                  className="h-2 rounded-full bg-steel-100"
                  style={{ width: `${95 - ((index * 13) % 45)}%` }}
                />
              ))}
            </div>
            <p className="pt-6 text-center text-[11px] text-steel-400">
              Page 1 of {document.pageCount}
            </p>
          </div>
          <p className="mt-4 text-center text-xs text-steel-500">
            Document preview is simulated in this demonstration. The production system streams the
            stored file through the storage service.
          </p>
        </div>

        <Card padded={false} className="shadow-none">
          <CardHeader title="Document details" className="px-4 pt-4" />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
            {[
              ['File name', document.fileName],
              ['Version', document.version],
              ['Status', STATUS_LABEL[document.status]],
              ['Pages', String(document.pageCount)],
              ['File size', formatFileSize(document.fileSizeBytes)],
              ['Uploaded', formatDate(document.uploadedAt)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 border-b border-steel-100 pb-2">
                <dt className="text-steel-500">{label}</dt>
                <dd className="text-right font-medium text-steel-800">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    )}
  </Modal>
);

export default LibraryPage;
