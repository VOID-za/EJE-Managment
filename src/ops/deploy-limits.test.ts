import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES } from '@/lib/upload-limits';

/**
 * THE REVERSE PROXY HAS TO ACCEPT WHAT THE APPLICATION ACCEPTS.
 *
 * THE DEFECT THIS EXISTS FOR, AND IT WAS A REAL ONE. `MAX_VIDEO_BYTES` was
 * raised to 60 MB for MEDIA-5 and the Caddyfile still said 30 MB. On the live
 * deployment a technician's 40 MB video would have been refused BY THE PROXY: a
 * bare 413 with none of the application's own wording about what the limit is or
 * what to do instead, nothing in the application's log to say it happened, and
 * no way for anybody reading either to work out why. The application's careful
 * refusal — the size, the formats, the suggestion to shorten the clip — would
 * never have been reached.
 *
 * TWO NUMBERS IN TWO FILES THAT NOBODY WOULD THINK TO COMPARE, which is what a
 * test is for. The proxy's limit is deliberately the LARGER of the two: it is
 * the outer bound that stops an enormous body being buffered at all, and the
 * application is what measures and refuses properly, with words.
 */
const caddyfile = readFileSync(join(import.meta.dirname, '../../deploy/Caddyfile'), 'utf8');

/** `max_size 70MB` → bytes. Caddy takes a plain number or a size suffix. */
const bodyLimitBytes = (): number => {
  const match = /request_body\s*\{[^}]*?max_size\s+(\d+)\s*(KB|MB|GB)?/iu.exec(caddyfile);
  if (match === null) return Number.NaN;
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toUpperCase();
  const scale = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
  return value * scale;
};

describe('the deployment’s body limit', () => {
  it('is stated at all, so a passing run means something', () => {
    expect(caddyfile).toContain('request_body');
    expect(Number.isFinite(bodyLimitBytes())).toBe(true);
  });

  it('is LARGER than the biggest upload the application accepts', () => {
    /*
     * Strictly larger, not equal: a multipart envelope carries boundaries, the
     * file name, the content type and the other fields, so a body at exactly
     * the file limit is bigger than the file.
     */
    expect(bodyLimitBytes()).toBeGreaterThan(MAX_VIDEO_BYTES);
    expect(bodyLimitBytes()).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  it('leaves room for the multipart envelope, not merely one byte', () => {
    // A megabyte of headroom. Enough for any envelope, and small enough that
    // the proxy is still an outer bound rather than no bound at all.
    expect(bodyLimitBytes() - MAX_VIDEO_BYTES).toBeGreaterThanOrEqual(1024 ** 2);
  });
});
