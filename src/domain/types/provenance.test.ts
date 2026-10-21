import { describe, expect, it } from 'vitest';
import {
  asProvenance,
  isProvenanceUnrecorded,
  isSimulated,
  PROVENANCE,
  SIMULATED_NOTICE,
  SIMULATED_NOTICE_PRINT,
  UNRECORDED_PROVENANCE_BADGE,
  UNRECORDED_PROVENANCE_NOTICE,
} from './provenance';

/**
 * READING A STORED PROVENANCE, AND ERRING TOWARDS SAYING NOTHING.
 * October mandate §1.3.
 *
 * This parse used to be written out six times as
 * `row.provenance === 'genuine' ? 'genuine' : 'simulated'`, which turned every
 * value the build did not understand into an accusation — a real customer's
 * document stamped SIMULATED — NOT A GENUINE EJE DOCUMENT. It is one function
 * now, and these are the three answers it may give.
 */
describe('reading a stored provenance', () => {
  it('believes the two values that were positively written', () => {
    expect(asProvenance('genuine')).toBe('genuine');
    expect(asProvenance('simulated')).toBe('simulated');
  });

  it('reads a value nobody recorded as UNKNOWN, not as genuine', () => {
    // The whole point: a row whose origin was defaulted must not be laundered
    // into a claim that EJE produced it.
    expect(asProvenance('unknown')).toBe('unknown');
    expect(asProvenance(null)).toBe('unknown');
    expect(asProvenance(undefined)).toBe('unknown');
    expect(asProvenance('')).toBe('unknown');
  });

  it('reads a value it does not understand as UNKNOWN, not as simulated', () => {
    /*
     * Both directions are false statements and this one is worse: SIMULATED on
     * a genuine record invites somebody to discard it. An unreadable value is
     * precisely a provenance nobody here can vouch for.
     */
    expect(asProvenance('probably-fine')).toBe('unknown');
    expect(asProvenance('GENUINE')).toBe('unknown');
    expect(asProvenance('demo')).toBe('unknown');
  });

  it('keeps the two questions apart', () => {
    expect(isSimulated('simulated')).toBe(true);
    expect(isSimulated('unknown')).toBe(false);
    expect(isProvenanceUnrecorded('unknown')).toBe(true);
    expect(isProvenanceUnrecorded('genuine')).toBe(false);
    // "Not recorded" is not "is a fixture", and nothing may read it that way.
    expect(isSimulated('unknown')).toBe(isProvenanceUnrecorded('simulated'));
  });

  it('lists all three values, so nothing iterates over a stale pair', () => {
    expect([...PROVENANCE].sort()).toEqual(['genuine', 'simulated', 'unknown']);
  });
});

describe('the wording', () => {
  it('says the same thing on screen and on paper, in characters each can draw', () => {
    // The PDF variant exists because the renderer's fonts carry no em dash and
    // a gap in this one line reads as a glitch rather than a statement.
    expect(SIMULATED_NOTICE).toContain('NOT A GENUINE EJE DOCUMENT');
    expect(SIMULATED_NOTICE_PRINT).toContain('NOT A GENUINE EJE DOCUMENT');
    expect(SIMULATED_NOTICE_PRINT).not.toMatch(/[—–]/u);
  });

  /**
   * THE UNRECORDED NOTICE IS A STATEMENT ABOUT RECORD-KEEPING, NOT ABOUT THE
   * DOCUMENT, and the wording has to stay that way: a technician reading
   * "NOT A GENUINE EJE DOCUMENT" on a real job card would act on it.
   */
  it('never calls an unrecorded record a demonstration one', () => {
    expect(UNRECORDED_PROVENANCE_NOTICE).not.toContain('SIMULATED');
    expect(UNRECORDED_PROVENANCE_NOTICE).not.toContain('NOT A GENUINE');
    expect(UNRECORDED_PROVENANCE_NOTICE).toMatch(/not recorded/iu);
    expect(UNRECORDED_PROVENANCE_NOTICE).toMatch(/has not guessed/iu);
    expect(UNRECORDED_PROVENANCE_BADGE).toBe('ORIGIN NOT RECORDED');
  });
});
