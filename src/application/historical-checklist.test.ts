import { describe, expect, it } from 'vitest';
import { loadJobView } from './job-view';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { asChecklistTemplateId } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Historical checklist wording.
 *
 * A signed job card is evidence of what the customer was shown. When the
 * checklist wording is later revised, the old job card must keep rendering the
 * revision that was actually presented and answered — never the current one.
 */

const buildRepos = (): RepositoryBundle => {
  const store = new DemoStore();
  return createDemoRepositories({ read: store.read, commit: store.commit });
};

const SERVICE_TEMPLATE = asChecklistTemplateId('chk-service');

describe('checklist template resolution', () => {
  it('offers a new service job the Milling and Lathe checklists, never the demonstration wording', async () => {
    const repos = buildRepos();
    const current = await repos.checklistTemplates.listCurrentForJobType('service');

    expect(current.map((template) => template.kind)).toEqual(['service_milling', 'service_lathe']);
    // CHK-SRC-1: 2.0-DEMO is archived, kept for the jobs that answered it.
    const demo = await repos.checklistTemplates.findByVersion(SERVICE_TEMPLATE, '2.0-DEMO');
    expect(demo?.status).toBe('archived');
  });

  it('can still retrieve the archived version 1.0 by version', async () => {
    const repos = buildRepos();
    const historical = await repos.checklistTemplates.findByVersion(
      SERVICE_TEMPLATE,
      '1.0-DEMO',
    );

    expect(historical).not.toBeNull();
    expect(historical?.version).toBe('1.0-DEMO');
    expect(historical?.status).toBe('archived');
  });

  it('returns null for a version that is not held, rather than falling back', async () => {
    const repos = buildRepos();
    const missing = await repos.checklistTemplates.findByVersion(SERVICE_TEMPLATE, '9.9-DEMO');
    expect(missing).toBeNull();
  });
});

describe('a historical job renders the version it was answered against', () => {
  it('resolves EJE-1044 to checklist version 1.0, not the current 2.0', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1044');

    expect(view).not.toBeNull();
    expect(view?.job.checklist?.templateVersion).toBe('1.0-DEMO');
    expect(view?.checklistTemplate?.version).toBe('1.0-DEMO');
    expect(view?.checklistVersionMissing).toBe(false);
  });

  it('renders the version 1.0 wording, which differs from version 2.0', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1044');
    const current = await repos.checklistTemplates.findByVersion(SERVICE_TEMPLATE, '2.0-DEMO');

    const historicalItem = view?.checklistTemplate?.sections
      .flatMap((section) => section.items)
      .find((item) => item.id === 'svc-1');
    const currentItem = current?.sections
      .flatMap((section) => section.items)
      .find((item) => item.id === 'svc-1');

    expect(historicalItem?.text).toBe('Emergency stops functional');
    expect(currentItem?.text).toBe(
      'Emergency stops tested on every station and confirmed functional',
    );
    expect(historicalItem?.text).not.toBe(currentItem?.text);
  });

  it('does not show items that were only added in version 2.0', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1044');
    const current = await repos.checklistTemplates.findByVersion(SERVICE_TEMPLATE, '2.0-DEMO');

    const historicalIds = (view?.checklistTemplate?.sections ?? [])
      .flatMap((section) => section.items)
      .map((item) => item.id);
    const currentIds = (current?.sections ?? [])
      .flatMap((section) => section.items)
      .map((item) => item.id);

    // svc-16 (isolator lock-out) was introduced in 2.0.
    expect(currentIds).toContain('svc-16');
    expect(historicalIds).not.toContain('svc-16');
  });

  it('keeps the acceptance range that applied at the time', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1044');
    const current = await repos.checklistTemplates.findByVersion(SERVICE_TEMPLATE, '2.0-DEMO');

    const historicalRange = view?.checklistTemplate?.sections
      .flatMap((section) => section.items)
      .find((item) => item.id === 'svc-5')?.expectedRange;
    const currentRange = current?.sections
      .flatMap((section) => section.items)
      .find((item) => item.id === 'svc-5')?.expectedRange;

    // 1.0 permitted up to 40 °C; 2.0 tightened it to 35 °C. The recorded 38 °C
    // reading passed under the rules that actually applied.
    expect(historicalRange).toEqual({ min: 10, max: 40 });
    expect(currentRange).toEqual({ min: 10, max: 35 });
  });
});

describe('a new service job uses the current version', () => {
  /*
   * CHK-SRC-1. A service job with no checklist yet is not handed one: it is
   * offered the Milling and Lathe checklists, and the technician chooses.
   */
  it('offers EJE-1049 the Milling and Lathe checklists because it has none yet', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1049');

    expect(view).not.toBeNull();
    expect(view?.job.checklist).toBeNull();
    expect(view?.checklistTemplate).toBeNull();
    expect(view?.checklistChoiceRequired).toBe(true);
    expect(view?.checklistOptions.map((option) => option.kind)).toEqual([
      'service_milling',
      'service_lathe',
    ]);
  });

  it('offers EJE-1053 the same choice, for the same reason', async () => {
    const repos = buildRepos();
    const view = await loadJobView(repos, 'EJE-1053');

    expect(view?.job.checklist).toBeNull();
    expect(view?.checklistTemplate).toBeNull();
    expect(view?.checklistOptions.map((option) => option.version)).toEqual(['1.0', '1.0']);
  });
});
