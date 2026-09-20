import { describe, expect, it } from 'vitest';
import { signatoryLabelsFor, signatureDeclarationFor } from './signatory';
import { getJobTypeDefinition, JOB_TYPE_CODES } from './job-types';
import { PARTS_COLLECTION_DECLARATION, SIGNATURE_DECLARATION } from '../types/job';

describe('signatoryLabelsFor', () => {
  it('asks a parts collector to acknowledge receipt, not completed work', () => {
    const labels = signatoryLabelsFor('parts');
    expect(labels.declaration).toBe(PARTS_COLLECTION_DECLARATION);
    expect(labels.nameLabel).toBe('Collector name');
    expect(labels.surnameLabel).toBe('Collector surname');
  });

  it('asks the customer to confirm the work on every job done on their site', () => {
    // Everything the technician attends. What is collected from the EJE counter
    // — parts, and a repaired unit — is signed for by whoever collects it.
    for (const code of JOB_TYPE_CODES.filter(
      (candidate) => !getJobTypeDefinition(candidate).collectedOnCompletion,
    )) {
      const labels = signatoryLabelsFor(code);
      expect(labels.declaration, code).toBe(SIGNATURE_DECLARATION);
      expect(labels.nameLabel, code).toBe('Customer name');
    }
  });

  it('asks whoever collects to confirm receipt, on the collected job types', () => {
    for (const code of JOB_TYPE_CODES.filter(
      (candidate) => getJobTypeDefinition(candidate).collectedOnCompletion,
    )) {
      const labels = signatoryLabelsFor(code);
      expect(labels.declaration, code).not.toBe(SIGNATURE_DECLARATION);
      expect(labels.declaration, code).toContain('I confirm that I have collected');
      expect(labels.nameLabel, code).toBe('Collector name');
    }
  });

  it('agrees with the declaration stored against the signature', () => {
    for (const code of JOB_TYPE_CODES) {
      expect(signatureDeclarationFor(code)).toBe(signatoryLabelsFor(code).declaration);
    }
  });
});
