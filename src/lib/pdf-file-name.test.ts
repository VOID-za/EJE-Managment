import { describe, expect, it } from 'vitest';
import { normalisePdfFileName, sameFileName } from './pdf-file-name';

/** PAYROLL-ONE-1: the name a person gives a working PDF — metadata, never a path. */
describe('normalisePdfFileName', () => {
  const ok = (raw: string) => {
    const result = normalisePdfFileName(raw);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.ok ? result.name : '';
  };
  const problem = (raw: string) => {
    const result = normalisePdfFileName(raw);
    expect(result.ok, raw).toBe(false);
    return result.ok ? '' : result.problem;
  };

  it('adds .pdf when it is left off, keeps it when given, and makes the extension lower-case', () => {
    expect(ok('JC Timesheet Nov 2026')).toBe('JC Timesheet Nov 2026.pdf');
    expect(ok('JC Timesheet Nov 2026.pdf')).toBe('JC Timesheet Nov 2026.pdf');
    expect(ok('JC Timesheet.PDF')).toBe('JC Timesheet.pdf');
  });

  it('tidies spaces and normalises the text', () => {
    expect(ok('  JC   Timesheet \t Nov  ')).toBe('JC Timesheet Nov.pdf');
    // é typed as e + combining accent is the same name as é.
    expect(ok('Ren\u0065\u0301 Attendance')).toBe('Ren\u00e9 Attendance.pdf');
  });

  it('accepts letters and digits of any language and the allowed punctuation', () => {
    // A dash that is not the keyboard's hyphen is not in the list: said, not silently changed.
    expect(problem('Ndlovu – Sipho')).toMatch(/cannot contain “–”/u);
    expect(ok("O'Brien (Oct-Nov), v1.2 & co_final")).toBe("O'Brien (Oct-Nov), v1.2 & co_final.pdf");
    expect(ok('Ζωή 日本 Ümit')).toBe('Ζωή 日本 Ümit.pdf');
  });

  it('refuses empty names', () => {
    expect(problem('')).toMatch(/Enter a file name/u);
    expect(problem('   ')).toMatch(/Enter a file name/u);
    expect(problem('.pdf')).toMatch(/before \.pdf/u);
  });

  it('refuses paths, traversal and every character a device rejects', () => {
    for (const raw of ['../etc/passwd', '..\\secret', 'a/b', 'C:\\x', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(problem(raw), raw).toMatch(/cannot contain|cannot start|two dots/u);
    }
    expect(problem('x..y')).toMatch(/two dots/u);
    expect(problem('.hidden')).toMatch(/start with a dot/u);
    expect(problem('name..pdf')).toMatch(/end in a dot|two dots/u);
  });

  it('refuses control and invisible formatting characters (a right-to-left override)', () => {
    expect(problem('abc\u202Efdp.exe')).toMatch(/invisible character/u);
    expect(problem('a\u0000b')).toMatch(/invisible character/u);
    expect(problem('a\u200Bb')).toMatch(/invisible character/u);
  });

  it('refuses another extension and names devices keep for themselves', () => {
    expect(problem('report.docx')).toMatch(/not \.docx/u);
    expect(problem('run.exe')).toMatch(/not \.exe/u);
    expect(problem('CON')).toMatch(/keep for themselves/u);
    expect(problem('lpt1.pdf')).toMatch(/keep for themselves/u);
  });

  it('allows 120 characters in all, .pdf included, and no more', () => {
    expect(ok('x'.repeat(116))).toHaveLength(120);
    expect(problem('x'.repeat(117))).toMatch(/120 characters/u);
  });

  it('treats names differing only by case as the same file', () => {
    expect(sameFileName('JC Timesheet.pdf', 'jc timesheet.PDF')).toBe(true);
    expect(sameFileName('JC Timesheet.pdf', 'JC Attendance.pdf')).toBe(false);
  });
});
