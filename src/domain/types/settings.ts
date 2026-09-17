import type { Cents } from './common';

/**
 * System configuration that Masters will eventually edit without developer
 * involvement. It is read through the settings repository rather than imported
 * as constants, so moving it into a database table is a repository change only.
 */
export interface LabourRateConfig {
  readonly normal: Cents;
  readonly overtime: Cents;
  readonly double: Cents;
}

export interface SystemSettings {
  readonly companyName: string;
  readonly companyRegistration: string;
  readonly companyVatNumber: string;
  readonly companyPhone: string;
  readonly companyEmail: string;
  readonly companyAddress: string;
  /** Rate per hour, in cents, by labour type. */
  readonly labourRates: LabourRateConfig;
  /** Rate per kilometre, in cents. */
  readonly kilometreRate: Cents;
  /** VAT as a percentage, e.g. 15 for 15%. */
  readonly vatPercentage: number;
  readonly jobNumberPrefix: string;
  readonly nextJobSequence: number;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
}
