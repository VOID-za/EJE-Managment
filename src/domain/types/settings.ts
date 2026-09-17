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

/**
 * Every value needed to price a job, with no reference to the settings record
 * they came from.
 *
 * This is the shape that gets frozen onto a job when the customer signs. Storing
 * a settings *id* would not be enough: the settings record is mutable, so a later
 * rate change would silently re-price a signed job card. The values themselves
 * are copied so that the arithmetic on a historical job card can always be
 * reproduced exactly as the customer saw it.
 */
export interface PricingInputs {
  readonly labourRates: LabourRateConfig;
  /** Fixed call-out fee, in cents, charged once on jobs where it applies. */
  readonly calloutRate: Cents;
  /** Rate per kilometre, in cents. */
  readonly kilometreRate: Cents;
  /** VAT as a percentage, e.g. 15 for 15%. */
  readonly vatPercentage: number;
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
  /** Fixed call-out fee, in cents. Applied per job, at the office's discretion. */
  readonly calloutRate: Cents;
  /** Rate per kilometre, in cents. */
  readonly kilometreRate: Cents;
  /** VAT as a percentage, e.g. 15 for 15%. */
  readonly vatPercentage: number;
  readonly jobNumberPrefix: string;
  readonly nextJobSequence: number;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
}
