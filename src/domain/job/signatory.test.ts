import { describe, expect, it } from 'vitest';
import { signatoryLabelsFor, signatureDeclarationFor } from './signatory';
import { JOB_TYPE_CODES } from './job-types';
import { PARTS_COLLECTION_DECLARATION, SIGNATURE_DECLARATION } from '../types/job';

describe('signatoryLabelsFor', () => {
  it('asks a parts collector to acknowledge receipt, not completed work', () => {
    const labels = signatoryLabelsFor('parts');
    expect(labels.declaration).toBe(PARTS_COLLECTION_DECLARATION);
    expect(labels.nameLabel).toBe('Collector name');
    expect(labels.surnameLabel).toBe('Collector surname');
  });

  it('asks the customer to confirm the work on every site job type', () => {
    for (const code of JOB_TYPE_CODES.filter((candidate) => candidate !== 'parts')) {
      const labels = signatoryLabelsFor(code);
      expect(labels.declaration).toBe(SIGNATURE_DECLARATION);
      expect(labels.nameLabel).toBe('Customer name');
    }
  });

  it('agrees with the declaration stored against the signature', () => {
    for (const code of JOB_TYPE_CODES) {
      expect(signatureDeclarationFor(code)).toBe(signatoryLabelsFor(code).declaration);
    }
  });
});
