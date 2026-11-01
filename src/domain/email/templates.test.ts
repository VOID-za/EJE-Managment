import { describe, expect, it } from 'vitest';
import {
  EMAIL_EVENTS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_PLACEHOLDERS,
  SAMPLE_PLACEHOLDER_VALUES,
  SYSTEM_EMAIL_TEMPLATES,
  UnknownPlaceholderError,
  emailRetryAt,
  isPlausibleEmailAddress,
  placeholdersIn,
  renderEmailBody,
  renderEmailSubject,
  validateEmailTemplate,
  type PlaceholderValues,
} from './templates';

/**
 * INT-EMAIL-1/2. The template rules the office is shown, proved: which
 * placeholders exist, what may be saved, and what a filled-in email says.
 */

const values = (overrides: Partial<PlaceholderValues> = {}): PlaceholderValues => ({ ...SAMPLE_PLACEHOLDER_VALUES, ...overrides });

describe('the placeholders', () => {
  it('include every one the owner asked for, each with a source and an example', () => {
    const keys = EMAIL_PLACEHOLDERS.map((placeholder) => placeholder.key);
    for (const required of [
      'customer_name',
      'company_name',
      'customer_email',
      'job_number',
      'job_type',
      'machine_name',
      'site_name',
      'site_address',
      'technician_name',
      'completion_date',
      'order_number',
      'reference',
    ]) {
      expect(keys).toContain(required);
    }
    for (const placeholder of EMAIL_PLACEHOLDERS) {
      expect(placeholder.source.length, placeholder.key).toBeGreaterThan(10);
      expect(placeholder.example.length, placeholder.key).toBeGreaterThan(0);
    }
  });

  it('are found with or without spaces inside the braces', () => {
    expect(placeholdersIn('{{job_number}} and {{ customer_name }}')).toEqual(['job_number', 'customer_name']);
  });
});

describe('validation before a template is saved or activated', () => {
  const good = { name: 'Breakdown', subject: '{{job_number}} — Signed', body: 'Hello {{customer_name}}' };

  it('accepts a sound template', () => {
    expect(validateEmailTemplate(good)).toEqual([]);
  });

  it('names an unknown placeholder, in the subject or the body', () => {
    const problems = validateEmailTemplate({ ...good, subject: '{{jobnumber}}', body: 'Dear {{custmer_name}}' });
    expect(problems.map((problem) => `${problem.field}:${problem.code}`)).toEqual([
      'subject:unknown_placeholder',
      'body:unknown_placeholder',
    ]);
    expect(problems[1]?.message).toContain('{{custmer_name}}');
  });

  it('refuses braces that do not make a whole placeholder', () => {
    for (const body of ['Dear {{customer_name', 'Dear customer_name}}', 'Dear {customer_name}']) {
      expect(validateEmailTemplate({ ...good, body }).map((problem) => problem.code), body).toContain('stray_braces');
    }
  });

  it('refuses an empty subject, an empty message, no name, and a subject on two lines', () => {
    const codes = validateEmailTemplate({ name: ' ', subject: 'a\nb', body: '  ' }).map((problem) => problem.code);
    expect(codes).toEqual(expect.arrayContaining(['name_required', 'body_required', 'subject_one_line']));
  });

  it('refuses a template over the limits', () => {
    const codes = validateEmailTemplate({ ...good, subject: 'x'.repeat(301), body: 'y'.repeat(20_001) }).map((problem) => problem.code);
    expect(codes).toEqual(expect.arrayContaining(['subject_too_long', 'body_too_long']));
  });
});

describe('rendering', () => {
  it('fills every placeholder in the subject and the body', () => {
    expect(renderEmailSubject('{{job_number}} — {{document_title}}', values())).toBe('EJE-2078 — Signed Job Card');
    expect(renderEmailBody('Dear {{customer_name}}, job {{ job_number }}.', values())).toBe('Dear Thandi Mokoena, job EJE-2078.');
  });

  it('leaves out a body line whose placeholders are all blank — and keeps a line with one filled', () => {
    const body = 'Order number: {{order_number}}\nReference: {{reference}}\nSite: {{site_name}} {{order_number}}';
    expect(renderEmailBody(body, values({ order_number: '', reference: '' }))).toBe('Site: Wadeville Plant');
  });

  it('collapses the gaps a blank value leaves in the subject', () => {
    expect(renderEmailSubject('{{job_number}} — {{order_number}} — Breakdown', values({ order_number: '' }))).toBe('EJE-2078 — Breakdown');
    expect(renderEmailSubject('{{order_number}} — {{job_number}}', values({ order_number: '' }))).toBe('EJE-2078');
  });

  it('never lets a value add a line to the subject, or a placeholder of its own', () => {
    const subject = renderEmailSubject('{{company_name}}', values({ company_name: 'Acme\r\nBcc: someone@evil.example' }));
    expect(subject).not.toMatch(/[\r\n]/u);
    expect(renderEmailBody('{{company_name}}', values({ company_name: 'Acme {{customer_email}}' }))).toBe('Acme customer_email');
  });

  it('REFUSES to render an unknown placeholder rather than send it to a customer', () => {
    expect(() => renderEmailBody('Dear {{custmer_name}}', values())).toThrow(UnknownPlaceholderError);
    expect(() => renderEmailSubject('{{nope}}', values())).toThrow(UnknownPlaceholderError);
  });
});

describe('the templates EJE ships', () => {
  it('cover the four job types the owner named (and Parts), one each, all valid', () => {
    const jobTypes = SYSTEM_EMAIL_TEMPLATES.map((template) => template.jobType);
    expect(jobTypes).toEqual(expect.arrayContaining(['breakdown', 'installation', 'service', 'test_and_repair', 'parts']));
    expect(new Set(SYSTEM_EMAIL_TEMPLATES.map((template) => template.systemKey)).size).toBe(SYSTEM_EMAIL_TEMPLATES.length);
    for (const template of SYSTEM_EMAIL_TEMPLATES) {
      expect(validateEmailTemplate(template), template.systemKey).toEqual([]);
      expect(EMAIL_EVENTS[0]!.jobTypes).toContain(template.jobType);
    }
  });

  it('read cleanly for a job with no order number, reference or machine', () => {
    const breakdown = SYSTEM_EMAIL_TEMPLATES.find((template) => template.jobType === 'breakdown')!;
    const body = renderEmailBody(breakdown.body, values({ order_number: '', reference: '', machine_name: '' }));
    expect(body).not.toMatch(/Order number:|Reference:|Machine:/u);
    expect(body).toContain('EJE-2078');
  });
});

describe('the outbox rules', () => {
  it('backs off after each temporary failure, and gives up after the last attempt', () => {
    const now = '2026-11-01T08:00:00.000Z';
    const first = emailRetryAt(now, 1, null)!;
    const second = emailRetryAt(now, 2, null)!;
    expect(Date.parse(first) - Date.parse(now)).toBe(60_000);
    expect(Date.parse(second) - Date.parse(now)).toBe(5 * 60_000);
    // A provider's own Retry-After is honoured when it is longer.
    expect(Date.parse(emailRetryAt(now, 1, 600)!) - Date.parse(now)).toBe(600_000);
    expect(emailRetryAt(now, EMAIL_MAX_ATTEMPTS, null)).toBeNull();
  });

  it('only calls a single plausible address a recipient', () => {
    expect(isPlausibleEmailAddress('pieter@abc-engineering.co.za')).toBe(true);
    for (const bad of ['', 'not-an-address', 'a@b', 'a b@c.co.za', 'one@a.co.za,two@b.co.za', 'x@y.co.za;z@w.co.za']) {
      expect(isPlausibleEmailAddress(bad), bad).toBe(false);
    }
  });
});
