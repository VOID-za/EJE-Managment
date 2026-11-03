import {
  getJobTypeDefinition,
  asCustomerId,
  can,
  customerRateModeOf,
  pricingInputsFrom,
  CUSTOMER_RATE_MODE_LABELS,
  type Customer,
  type CustomerRateMode,
  type CustomerRates,
  type Job,
  type PricingInputs,
  type SystemSettings,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * CUSTOMER-SPECIFIC RATES. CUST-RATES-1 (2 November 2026).
 *
 * THE RATE SOURCE IS DECIDED HERE, ON THE SERVER, AND NOWHERE ELSE. A customer
 * on Default Rates is priced at Administration's current rates; a customer on
 * Custom Rates at its own — for labour (NT, OT, DT), call-out, the test bench,
 * travel and VAT. Every path that prices a job asks this: the job screen and
 * its documents (`loadJobView`), and the moments a job card's prices are FROZEN
 * into its snapshot (signature, refusal, issue — `customerPricingInputs`).
 *
 * NO SILENT FALL-BACK. A Custom Rates customer without rates set is NOT priced
 * at the defaults: the job screen says so plainly and prices nothing (every
 * rate reads zero, flagged), and freezing the prices — taking the customer's
 * signature, recording a refusal, issuing — is REFUSED until the office sets
 * them.
 *
 * NOTHING ALREADY PRICED MOVES. A signed or issued job card carries its pricing
 * snapshot, and every document and total reads the snapshot; changing the
 * default or a customer's custom rates afterwards reaches no such job.
 */
export interface JobRateSource {
  readonly mode: CustomerRateMode;
  /** The settings to price with: the defaults, or the defaults' other fields with the customer's rates. */
  readonly settings: SystemSettings;
  /** Why this job cannot be priced, or null. Only ever for a Custom Rates customer without rates. */
  readonly problem: string | null;
}

const ZERO_RATES: PricingInputs = {
  labourRates: { normal: 0, overtime: 0, double: 0 },
  calloutRate: 0,
  testBenchFee: 0,
  kilometreRate: 0,
  vatPercentage: 0,
};

const withRates = (settings: SystemSettings, rates: PricingInputs): SystemSettings => ({
  ...settings,
  labourRates: { ...rates.labourRates },
  calloutRate: rates.calloutRate,
  testBenchFee: rates.testBenchFee ?? 0,
  kilometreRate: rates.kilometreRate,
  vatPercentage: rates.vatPercentage,
});

export const customRatesMissing = (customer: Pick<Customer, 'name'>): string =>
  `${customer.name} is on Custom Rates, but its custom rates have not been set. Job cards for this customer cannot be priced until a Senior Tech or the Office sets them on the customer's Custom Rates tab.`;

/** The rates that price this customer's jobs, decided from the customer's own mode. */
export const resolveCustomerRateSource = async (
  context: Pick<OperationContext, 'repos'>,
  customerId: string,
  settings?: SystemSettings,
): Promise<JobRateSource> => {
  const defaults = settings ?? (await context.repos.settings.get());
  const customer = await context.repos.customers.findById(asCustomerId(customerId));
  if (customer === null || customerRateModeOf(customer) === 'default') {
    return { mode: 'default', settings: defaults, problem: null };
  }
  const rates = await context.repos.customers.findCustomRates(customer.id);
  if (rates === null) return { mode: 'custom', settings: withRates(defaults, ZERO_RATES), problem: customRatesMissing(customer) };
  return { mode: 'custom', settings: withRates(defaults, rates), problem: null };
};

/**
 * The rates a job's prices are frozen at. Refuses for a Custom Rates customer
 * whose rates are not set — never the defaults instead.
 */
export const customerPricingInputs = async (context: OperationContext, job: Pick<Job, 'customerId' | 'jobNumber'> & Partial<Pick<Job, 'jobType'>>): Promise<PricingInputs> => {
  const source = await resolveCustomerRateSource(context, job.customerId);
  // DELIVERY-NOTE-1: a job type that prices nothing is never blocked by missing Custom Rates — it has no amount to price.
  if (source.problem !== null && job.jobType !== undefined && !getJobTypeDefinition(job.jobType).priced) {
    return pricingInputsFrom((await context.repos.settings.get()));
  }
  if (source.problem !== null) {
    throw new WorkflowError(`${job.jobNumber} cannot be priced: its customer's custom rates are not set.`, [
      { code: 'custom_rates_missing', message: source.problem },
    ]);
  }
  return pricingInputsFrom(source.settings);
};

/* -------------------------------------------------------------------------- */
/* The office's operations                                                    */
/* -------------------------------------------------------------------------- */

const assertSetsRates = (context: OperationContext): void => {
  if (!can(context.actor.role, 'settings.rates') || !can(context.actor.role, 'customers.manage')) {
    throw new WorkflowError('Only the office sets a customer’s rates.', [
      { code: 'not_permitted', message: 'A customer’s rate option and Custom Rates are set by a Senior Tech or the Office.' },
    ]);
  }
};

export interface CustomerRatesView {
  readonly mode: CustomerRateMode;
  readonly rates: CustomerRates | null;
  /** Administration's current rates, for comparison on the tab. */
  readonly defaults: PricingInputs;
  readonly canEdit: boolean;
}

export const loadCustomerRates = async (context: OperationContext, customerId: string): Promise<CustomerRatesView> => {
  if (!can(context.actor.role, 'customers.manage')) {
    throw new WorkflowError('A customer’s rates are the office’s.', [
      { code: 'not_permitted', message: 'A customer’s rates are seen and set by a Senior Tech or the Office.' },
    ]);
  }
  const customer = await context.repos.customers.findById(asCustomerId(customerId));
  if (customer === null) {
    throw new WorkflowError('That customer does not exist.', [{ code: 'customer_not_found', message: 'Reload the customer list.' }]);
  }
  return {
    mode: customerRateModeOf(customer),
    rates: await context.repos.customers.findCustomRates(customer.id),
    defaults: pricingInputsFrom(await context.repos.settings.get()),
    canEdit: can(context.actor.role, 'settings.rates'),
  };
};

const MAX_CENTS = 100_000_000;
const ratesProblem = (rates: PricingInputs): string | null => {
  const money = [rates.labourRates.normal, rates.labourRates.overtime, rates.labourRates.double, rates.calloutRate, rates.testBenchFee ?? 0, rates.kilometreRate];
  if (money.some((value) => !Number.isInteger(value) || value < 0 || value > MAX_CENTS)) return 'Every rate must be an amount of zero or more.';
  if (!Number.isFinite(rates.vatPercentage) || rates.vatPercentage < 0 || rates.vatPercentage > 100) return 'VAT must be a percentage between 0 and 100.';
  return null;
};

/** Sets a Custom Rates customer's rates. Prices nothing already frozen. */
export const saveCustomerRates = async (
  context: OperationContext,
  customerId: string,
  rates: PricingInputs,
): Promise<CustomerRates> => {
  assertSetsRates(context);
  const customer = await context.repos.customers.findById(asCustomerId(customerId));
  if (customer === null) {
    throw new WorkflowError('That customer does not exist.', [{ code: 'customer_not_found', message: 'Reload the customer list.' }]);
  }
  if (customerRateModeOf(customer) !== 'custom') {
    throw new WorkflowError(`${customer.name} is on Default Rates.`, [
      { code: 'not_custom_rates', message: 'Choose Custom Rates for this customer first; until then its job cards use the Default Rates.' },
    ]);
  }
  const problem = ratesProblem(rates);
  if (problem !== null) throw new WorkflowError('Those rates cannot be saved.', [{ code: 'invalid_rates', message: problem }]);
  const previous = await context.repos.customers.findCustomRates(customer.id);
  const saved = await context.repos.customers.saveCustomRates({
    customerId: customer.id,
    labourRates: { ...rates.labourRates },
    calloutRate: rates.calloutRate,
    testBenchFee: rates.testBenchFee ?? 0,
    kilometreRate: rates.kilometreRate,
    vatPercentage: rates.vatPercentage,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  });
  const rand = (cents: number) => `R${(cents / 100).toFixed(2)}`;
  const field = (label: string, from: number | undefined, to: number, show: (value: number) => string = rand) =>
    from === to ? [] : [{ field: label, from: from === undefined ? '—' : show(from), to: show(to) }];
  await audit(context, {
    jobId: null,
    type: 'customer_rates_updated',
    summary: `Custom Rates ${previous === null ? 'set' : 'changed'} for ${customer.name}`,
    detail: `${customer.name}'s own rates now price its new job cards. Job cards already signed or issued keep the prices they were frozen at.`,
    changes: [
      ...field('Normal Time', previous?.labourRates.normal, saved.labourRates.normal),
      ...field('Overtime', previous?.labourRates.overtime, saved.labourRates.overtime),
      ...field('Double Time', previous?.labourRates.double, saved.labourRates.double),
      ...field('Call-out fee', previous?.calloutRate, saved.calloutRate),
      ...field('Test bench fee', previous?.testBenchFee, saved.testBenchFee ?? 0),
      ...field('Kilometre rate', previous?.kilometreRate, saved.kilometreRate),
      ...field('VAT', previous?.vatPercentage, saved.vatPercentage, (value) => `${value}%`),
    ],
  });
  return saved;
};

/** Changes a customer between Default and Custom Rates — the office's choice, never the customer's. */
export const setCustomerRateMode = async (
  context: OperationContext,
  customerId: string,
  mode: CustomerRateMode,
): Promise<Customer> => {
  assertSetsRates(context);
  const customer = await context.repos.customers.findById(asCustomerId(customerId));
  if (customer === null) {
    throw new WorkflowError('That customer does not exist.', [{ code: 'customer_not_found', message: 'Reload the customer list.' }]);
  }
  const current = customerRateModeOf(customer);
  if (current === mode) return customer;
  const saved = await context.repos.customers.save({ ...customer, rateMode: mode });
  await audit(context, {
    jobId: null,
    type: 'customer_rates_updated',
    summary: `${customer.name} moved to ${CUSTOMER_RATE_MODE_LABELS[mode]}`,
    detail: `New job cards for ${customer.name} are priced at its ${mode === 'custom' ? 'own Custom Rates' : 'Default Rates (Administration)'}. Job cards already signed or issued keep their prices.`,
    changes: [{ field: 'Rates', from: CUSTOMER_RATE_MODE_LABELS[current], to: CUSTOMER_RATE_MODE_LABELS[mode] }],
  });
  return saved;
};
