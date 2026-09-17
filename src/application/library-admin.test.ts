import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDocument,
  addDocumentVersion,
  approveDocument,
  archiveDocument,
  updateDocument,
} from './library-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * Technical library.
 *
 * A technician may contribute, but nothing becomes official reference material
 * without a Master. Revisions never overwrite what they supersede, so which
 * revision a technician worked from stays answerable.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

const NEW_DOCUMENT = {
  name: 'Doosan Puma 2600 Maintenance Schedule',
  description: 'Lubrication points and service intervals.',
  documentType: 'service_manual' as const,
  manufacturer: 'Doosan',
  machineModel: 'Puma 2600',
  version: '1.0',
  fileName: 'doosan-puma-2600-maintenance.pdf',
  pageCount: 24,
  tags: ['Doosan', 'Service'],
};

describe('a Master managing the library', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('publishes a document immediately', async () => {
    const document = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    expect(document.status).toBe('current');
  });

  it('edits document metadata', async () => {
    const document = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    const saved = await updateDocument(harness.as(elmarie), {
      ...document,
      description: 'Lubrication points, service intervals and filter part numbers.',
    });
    expect(saved.description).toContain('filter part numbers');
  });

  it('archives rather than deletes', async () => {
    const document = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    const archived = await archiveDocument(harness.as(elmarie), document);

    expect(archived.status).toBe('archived');
    const stored = await harness.repos.documents.findById(document.id);
    expect(stored).not.toBeNull();
  });

  it('publishes a revision and archives the one it supersedes', async () => {
    const first = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    const second = await addDocumentVersion(harness.as(elmarie), first, {
      version: '2.0',
      fileName: 'doosan-puma-2600-maintenance-rev2.pdf',
      pageCount: 26,
      description: '',
    });

    expect(second.version).toBe('2.0');
    expect(second.status).toBe('current');

    // The superseded revision survives, so what a technician read is answerable.
    const previous = await harness.repos.documents.findById(first.id);
    expect(previous?.status).toBe('archived');
    expect(previous?.version).toBe('1.0');
  });

  it('refuses a revision that reuses the version it replaces', async () => {
    const first = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    await expect(
      addDocumentVersion(harness.as(elmarie), first, {
        version: '1.0',
        fileName: '',
        pageCount: 24,
        description: '',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a technician contributing to the library', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('uploads a document that waits for approval', async () => {
    const document = await addDocument(harness.as(sipho), NEW_DOCUMENT);
    expect(document.status).toBe('pending_approval');
    expect(document.uploadedBy).toBe(sipho.id);
  });

  it('notifies every active Master about the upload', async () => {
    await addDocument(harness.as(sipho), NEW_DOCUMENT);

    const users = await harness.repos.users.list();
    for (const master of users.filter((user) => user.role === 'master' && user.active)) {
      const notifications = await harness.repos.notifications.list(master.id);
      expect(
        notifications.some((notification) => notification.type === 'document_approval_request'),
      ).toBe(true);
    }
  });

  it('cannot alter an approved document', async () => {
    const official = await addDocument(harness.as(elmarie), NEW_DOCUMENT);
    await expect(
      updateDocument(harness.as(sipho), { ...official, name: 'Rewritten' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot approve or archive a document', async () => {
    const pending = await addDocument(harness.as(sipho), NEW_DOCUMENT);
    await expect(
      approveDocument(harness.as(sipho), pending),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      archiveDocument(harness.as(sipho), pending),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('becomes official once a Master approves it', async () => {
    const pending = await addDocument(harness.as(sipho), NEW_DOCUMENT);
    const approved = await approveDocument(harness.as(elmarie), pending);
    expect(approved.status).toBe('current');
  });
});
