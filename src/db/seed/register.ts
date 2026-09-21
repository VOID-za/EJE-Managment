import {
  asAttachmentId,
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  type Attachment,
  type Contact,
  type Customer,
  type Machine,
  type MachineType,
  type Site,
} from '@/domain';
import { demoId } from './ids';
import { timeAgo } from './calendar';
import { COORDINATOR, MASTER, TECH1, TECH2 } from './people';

/**
 * The customer register: five fictional industrial customers, their sites,
 * their contacts and their machines.
 *
 * EVERY COMPANY NAME CARRIES "(DEMO)". Nothing in here is a real customer, a
 * real address, a real registration number or a real serial number, and the
 * suffix is on the name so a screenshot of any screen says so plainly.
 */
export const customerId = (key: string) => asCustomerId(demoId(`customer:${key}`));
export const siteId = (key: string) => asSiteId(demoId(`site:${key}`));
export const contactId = (key: string) => asContactId(demoId(`contact:${key}`));
export const machineId = (key: string) => asMachineId(demoId(`machine:${key}`));

interface CustomerInput {
  readonly key: string;
  readonly name: string;
  readonly account: string;
  readonly registration: string;
  readonly vat: string;
  readonly phone: string;
  readonly email: string;
  readonly industry: string;
  readonly terms: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly postalCode: string;
}

const customer = (input: CustomerInput): Customer => ({
  id: customerId(input.key),
  name: input.name,
  accountNumber: input.account,
  registrationNumber: input.registration,
  vatNumber: input.vat,
  phone: input.phone,
  email: input.email,
  industry: input.industry,
  paymentTerms: input.terms,
  officeAddress: {
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    province: 'Gauteng',
    postalCode: input.postalCode,
  },
  active: true,
  notes: [],
  documents: [],
  createdAt: timeAgo(800, 8),
});

export const seedCustomers: readonly Customer[] = [
  customer({
    key: 'acme',
    name: 'ACME Engineering Solutions (DEMO)',
    account: 'ACM001',
    registration: '2001/004521/07',
    vat: '4220100001',
    phone: '+27 11 555 0210',
    email: 'maintenance@acme-demo.local',
    industry: 'Precision Engineering',
    terms: '30 days from statement',
    line1: 'Unit 12, Isando Industrial Park',
    line2: '48 Steel Road',
    city: 'Isando',
    postalCode: '1600',
  }),
  customer({
    key: 'jia',
    name: 'Johannesburg Industrial Automation (DEMO)',
    account: 'JIA002',
    registration: '2009/118742/07',
    vat: '4220100002',
    phone: '+27 11 555 0330',
    email: 'plant@jia-demo.local',
    industry: 'Industrial Automation',
    terms: '30 days',
    line1: '7 Anvil Crescent',
    line2: 'Wadeville Extension 4',
    city: 'Germiston',
    postalCode: '1428',
  }),
  customer({
    key: 'pmg',
    name: 'Precision Manufacturing Gauteng (DEMO)',
    account: 'PMG003',
    registration: '2014/227813/07',
    vat: '4220100003',
    phone: '+27 12 555 0440',
    email: 'workshop@pmg-demo.local',
    industry: 'Tool & Die',
    terms: 'COD until account approved',
    line1: '26 Rotary Crescent',
    line2: 'Rosslyn Industrial',
    city: 'Pretoria',
    postalCode: '0200',
  }),
  customer({
    key: 'ams',
    name: 'Advanced Machine Systems (DEMO)',
    account: 'AMS004',
    registration: '2018/331902/07',
    vat: '4220100004',
    phone: '+27 11 555 0550',
    email: 'service@ams-demo.local',
    industry: 'Machine Building',
    terms: '45 days from invoice',
    line1: 'Block C, Midrand Business Park',
    line2: '1 Richards Drive',
    city: 'Midrand',
    postalCode: '1685',
  }),
  customer({
    key: 'sic',
    name: 'Southern Industrial Components (DEMO)',
    account: 'SIC005',
    registration: '1996/009118/07',
    vat: '4220100005',
    phone: '+27 16 555 0660',
    email: 'buying@sic-demo.local',
    industry: 'Component Manufacturing',
    terms: '30 days from statement',
    line1: '4 Furnace Street',
    line2: 'Duncanville',
    city: 'Vereeniging',
    postalCode: '1930',
  }),
];

interface SiteInput {
  readonly key: string;
  readonly customer: string;
  readonly name: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly postalCode: string;
  readonly access: string;
  readonly latitude: number;
  readonly longitude: number;
}

const site = (input: SiteInput): Site => ({
  id: siteId(input.key),
  customerId: customerId(input.customer),
  name: input.name,
  addressLine1: input.line1,
  addressLine2: input.line2,
  city: input.city,
  province: 'Gauteng',
  postalCode: input.postalCode,
  accessNotes: input.access,
  latitude: input.latitude,
  longitude: input.longitude,
  archivedAt: null,
});

export const seedSites: readonly Site[] = [
  site({
    key: 'acme:head',
    customer: 'acme',
    name: 'Head Office',
    line1: 'Unit 12, Isando Industrial Park',
    line2: '48 Steel Road',
    city: 'Isando',
    postalCode: '1600',
    access: 'Reception at the main gate. Visitor parking on the left.',
    latitude: -26.144,
    longitude: 28.213,
  }),
  site({
    key: 'acme:factory',
    customer: 'acme',
    name: 'Factory',
    line1: '50 Steel Road',
    line2: 'Isando Industrial Park',
    city: 'Isando',
    postalCode: '1600',
    access: 'Safety induction required before entering the machine hall. Allow 30 minutes.',
    latitude: -26.146,
    longitude: 28.215,
  }),
  site({
    key: 'jia:plant',
    customer: 'jia',
    name: 'Production Plant',
    line1: '7 Anvil Crescent',
    line2: 'Wadeville Extension 4',
    city: 'Germiston',
    postalCode: '1428',
    access: 'Report to the maintenance planner at the goods entrance.',
    latitude: -26.271,
    longitude: 28.176,
  }),
  site({
    key: 'jia:workshop',
    customer: 'jia',
    name: 'Workshop',
    line1: '9 Anvil Crescent',
    line2: 'Wadeville Extension 4',
    city: 'Germiston',
    postalCode: '1428',
    access: 'Workshop roller door, second on the right.',
    latitude: -26.272,
    longitude: 28.177,
  }),
  site({
    key: 'pmg:head',
    customer: 'pmg',
    name: 'Head Office',
    line1: '26 Rotary Crescent',
    line2: 'Rosslyn Industrial',
    city: 'Pretoria',
    postalCode: '0200',
    access: 'Sign in at the boom. Hard hat and safety shoes in the yard.',
    latitude: -25.61,
    longitude: 28.09,
  }),
  site({
    key: 'pmg:plant',
    customer: 'pmg',
    name: 'Production Plant',
    line1: '30 Rotary Crescent',
    line2: 'Rosslyn Industrial',
    city: 'Pretoria',
    postalCode: '0200',
    access: 'Night shift finishes at 06:00; the hall is quietest before 07:00.',
    latitude: -25.612,
    longitude: 28.092,
  }),
  site({
    key: 'ams:head',
    customer: 'ams',
    name: 'Head Office',
    line1: 'Block C, Midrand Business Park',
    line2: '1 Richards Drive',
    city: 'Midrand',
    postalCode: '1685',
    access: 'Visitor access through Block C reception.',
    latitude: -25.995,
    longitude: 28.126,
  }),
  site({
    key: 'ams:workshop',
    customer: 'ams',
    name: 'Workshop',
    line1: 'Block D, Midrand Business Park',
    line2: '1 Richards Drive',
    city: 'Midrand',
    postalCode: '1685',
    access: 'Roller door D3. Overhead crane available on request.',
    latitude: -25.996,
    longitude: 28.127,
  }),
  site({
    key: 'sic:factory',
    customer: 'sic',
    name: 'Factory',
    line1: '4 Furnace Street',
    line2: 'Duncanville',
    city: 'Vereeniging',
    postalCode: '1930',
    access: 'Gate 2 for service vehicles. No access during the 13:00 shift change.',
    latitude: -26.686,
    longitude: 27.928,
  }),
];

interface ContactInput {
  readonly key: string;
  readonly customer: string;
  readonly site: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly position: string;
  readonly email: string;
  readonly phone: string;
  readonly primary?: boolean;
}

const contact = (input: ContactInput): Contact => ({
  id: contactId(input.key),
  customerId: customerId(input.customer),
  siteId: input.site === null ? null : siteId(input.site),
  firstName: input.firstName,
  lastName: input.lastName,
  position: input.position,
  email: input.email,
  phone: input.phone,
  isPrimary: input.primary ?? false,
  archivedAt: null,
});

export const seedContacts: readonly Contact[] = [
  contact({
    key: 'acme:procurement',
    customer: 'acme',
    site: null,
    firstName: 'Marlene',
    lastName: 'Fourie',
    position: 'Group Procurement Manager',
    email: 'marlene.fourie@acme-demo.local',
    phone: '+27 11 555 0211',
    primary: true,
  }),
  contact({
    key: 'acme:maintenance',
    customer: 'acme',
    site: 'acme:factory',
    firstName: 'Pieter',
    lastName: 'Nel',
    position: 'Maintenance Supervisor',
    email: 'pieter.nel@acme-demo.local',
    phone: '+27 82 555 0322',
  }),
  /*
   * Deliberately incomplete: a real register has contacts somebody added from a
   * phone call, with no email address and no position yet. The screens have to
   * cope, and issuing a job card to this contact has to REFUSE rather than
   * silently send nowhere — which is worth being able to demonstrate.
   */
  contact({
    key: 'acme:storeman',
    customer: 'acme',
    site: 'acme:factory',
    firstName: 'Sipho',
    lastName: 'Radebe',
    position: '',
    email: '',
    phone: '+27 82 555 0323',
  }),
  contact({
    key: 'jia:planner',
    customer: 'jia',
    site: 'jia:plant',
    firstName: 'Ravi',
    lastName: 'Naidoo',
    position: 'Maintenance Planner',
    email: 'ravi.naidoo@jia-demo.local',
    phone: '+27 82 555 0331',
    primary: true,
  }),
  contact({
    key: 'jia:foreman',
    customer: 'jia',
    site: 'jia:workshop',
    firstName: 'Anton',
    lastName: 'Steyn',
    position: 'Workshop Foreman',
    email: 'anton.steyn@jia-demo.local',
    phone: '+27 82 555 0332',
  }),
  contact({
    key: 'pmg:engineer',
    customer: 'pmg',
    site: 'pmg:plant',
    firstName: 'Nomsa',
    lastName: 'Dlamini',
    position: 'Production Engineer',
    email: 'nomsa.dlamini@pmg-demo.local',
    phone: '+27 82 555 0441',
    primary: true,
  }),
  contact({
    key: 'ams:manager',
    customer: 'ams',
    site: 'ams:head',
    firstName: 'Gerhard',
    lastName: 'Botha',
    position: 'Operations Manager',
    email: 'gerhard.botha@ams-demo.local',
    phone: '+27 82 555 0551',
    primary: true,
  }),
  contact({
    key: 'ams:workshop',
    customer: 'ams',
    site: 'ams:workshop',
    firstName: 'Lebo',
    lastName: 'Mokoena',
    position: 'Workshop Controller',
    email: 'lebo.mokoena@ams-demo.local',
    phone: '+27 82 555 0552',
  }),
  contact({
    key: 'sic:buyer',
    customer: 'sic',
    site: 'sic:factory',
    firstName: 'Johan',
    lastName: 'van Zyl',
    position: 'Buyer',
    email: 'johan.vanzyl@sic-demo.local',
    phone: '+27 16 555 0661',
    primary: true,
  }),
];

const machinePhoto = (key: string, fileName: string, caption: string): Attachment => ({
  id: asAttachmentId(demoId(`attachment:${key}`)),
  kind: 'photo',
  fileName,
  caption,
  storageKey: `machines/${fileName}`,
  uploadedAt: timeAgo(200, 10),
  uploadedBy: TECH1,
  sizeBytes: 1_842_000,
});

interface MachineInput {
  readonly key: string;
  readonly customer: string;
  readonly site: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly serial: string;
  readonly number: string;
  readonly type: MachineType;
  readonly year: number;
  readonly installed: string;
  readonly control: string;
  readonly notes: string;
  readonly pending?: boolean;
  readonly photo?: readonly [string, string];
}

const machine = (input: MachineInput): Machine => ({
  id: machineId(input.key),
  customerId: customerId(input.customer),
  siteId: siteId(input.site),
  manufacturer: input.manufacturer,
  model: input.model,
  serialNumber: input.serial,
  machineNumber: input.number,
  machineType: input.type,
  year: input.year,
  installationDate: input.installed,
  controlSystem: input.control,
  notes: input.notes,
  photos:
    input.photo === undefined
      ? []
      : [machinePhoto(`${input.key}:1`, input.photo[0], input.photo[1])],
  active: true,
  approval: input.pending === true ? 'pending_approval' : 'approved',
  createdBy: input.pending === true ? TECH2 : MASTER,
  approvedBy: input.pending === true ? null : MASTER,
  approvedAt: input.pending === true ? null : timeAgo(400, 9),
  createdAt: timeAgo(input.pending === true ? 3 : 400, 9),
  archivedAt: null,
});

export const seedMachines: readonly Machine[] = [
  machine({
    key: 'acme:stm1',
    customer: 'acme',
    site: 'acme:factory',
    manufacturer: 'Mazak',
    model: 'QT-250',
    serial: 'MZ-QT250-40218',
    number: 'STM1',
    type: 'CNC Lathe',
    year: 2017,
    installed: '2017-04-18',
    control: 'Mazatrol SmoothG',
    notes: 'Bar feeder fitted 2021. Tailstock seals replaced under warranty.',
    photo: ['mazak-qt250-front.jpg', 'Machine front and control panel'],
  }),
  machine({
    key: 'acme:stm2',
    customer: 'acme',
    site: 'acme:factory',
    manufacturer: 'Haas',
    model: 'VF-2SS',
    serial: 'HS-VF2-118904',
    number: 'STM2',
    type: 'CNC Milling Machine',
    year: 2019,
    installed: '2019-09-02',
    control: 'Haas NGC',
    notes: 'Through-spindle coolant. Customer runs it three shifts.',
  }),
  machine({
    key: 'acme:stm3',
    customer: 'acme',
    site: 'acme:head',
    manufacturer: 'Okuma',
    model: 'Genos M560-V',
    serial: 'OK-M560-77310',
    number: 'STM3',
    type: 'Machining Centre',
    year: 2021,
    installed: '2021-02-11',
    control: 'OSP-P300MA',
    notes: 'Under a maintenance agreement. Service due every six months.',
  }),
  machine({
    key: 'jia:cnc01',
    customer: 'jia',
    site: 'jia:plant',
    manufacturer: 'Fanuc',
    model: 'Robodrill a-D21MiB5',
    serial: 'FN-D21-55204',
    number: 'CNC01',
    type: 'CNC Milling Machine',
    year: 2020,
    installed: '2020-06-30',
    control: 'Fanuc 31i-B5',
    notes: 'Feeds the automation cell. Downtime here stops the line.',
    photo: ['fanuc-robodrill-cabinet.jpg', 'Electrical cabinet, drive section'],
  }),
  machine({
    key: 'jia:cnc02',
    customer: 'jia',
    site: 'jia:plant',
    manufacturer: 'Siemens',
    model: 'SINUMERIK retrofit on Deckel FP4',
    serial: 'SM-FP4-20119',
    number: 'CNC02',
    type: 'CNC Milling Machine',
    year: 2016,
    installed: '2016-11-14',
    control: 'SINUMERIK 828D',
    notes: 'Retrofitted control. Original drives retained.',
  }),
  machine({
    key: 'jia:lathe01',
    customer: 'jia',
    site: 'jia:workshop',
    manufacturer: 'Okuma',
    model: 'LB3000 EX II',
    serial: 'OK-LB3000-61885',
    number: 'LATHE01',
    type: 'CNC Lathe',
    year: 2018,
    installed: '2018-08-21',
    control: 'OSP-P300L',
    notes: 'Workshop machine, single shift.',
  }),
  machine({
    key: 'pmg:cnc01',
    customer: 'pmg',
    site: 'pmg:plant',
    manufacturer: 'Mazak',
    model: 'VCN-530C',
    serial: 'MZ-VCN530-31002',
    number: 'CNC01',
    type: 'Machining Centre',
    year: 2015,
    installed: '2015-03-09',
    control: 'Mazatrol Matrix 2',
    notes: 'Oldest machine on the plant. Spindle rebuilt 2022.',
  }),
  machine({
    key: 'pmg:grinder',
    customer: 'pmg',
    site: 'pmg:head',
    manufacturer: 'Okamoto',
    model: 'ACC-1224DX',
    serial: 'OM-ACC-90417',
    number: '',
    type: 'Surface Grinder',
    year: 2013,
    installed: '2013-07-02',
    control: 'Manual with digital readout',
    notes: 'No machine number; the customer asks for it as "the grinder".',
  }),
  machine({
    key: 'ams:cnc01',
    customer: 'ams',
    site: 'ams:workshop',
    manufacturer: 'Haas',
    model: 'ST-20Y',
    serial: 'HS-ST20Y-44190',
    number: 'CNC01',
    type: 'CNC Lathe',
    year: 2022,
    installed: '2022-05-16',
    control: 'Haas NGC',
    notes: 'Live tooling and Y axis. Still within the build warranty.',
  }),
  machine({
    key: 'sic:press',
    customer: 'sic',
    site: 'sic:factory',
    manufacturer: 'Siemens',
    model: 'Control retrofit on Amada HFE',
    serial: 'SM-HFE-70255',
    number: 'PRESS01',
    type: 'Press Brake',
    year: 2014,
    installed: '2014-10-08',
    control: 'SINUMERIK 828D',
    notes: 'Safety light curtain interlocked to the control.',
  }),
  /*
   * Added by a technician on site and NOT yet confirmed by the office, so the
   * machine-approval queue has something in it.
   */
  machine({
    key: 'sic:stm4',
    customer: 'sic',
    site: 'sic:factory',
    manufacturer: 'Fanuc',
    model: 'Robocut a-C400iB',
    serial: 'FN-C400-88120',
    number: 'STM4',
    type: 'Other',
    year: 2023,
    installed: '2023-01-30',
    control: 'Fanuc 31i-WB',
    notes: 'Wire eroder. Added on site by the technician; awaiting confirmation.',
    pending: true,
  }),
];

/** Named for the jobs below, so a job never guesses at an id. */
export const REGISTER = {
  acme: {
    id: customerId('acme'),
    head: siteId('acme:head'),
    factory: siteId('acme:factory'),
    procurement: contactId('acme:procurement'),
    maintenance: contactId('acme:maintenance'),
    storeman: contactId('acme:storeman'),
    stm1: machineId('acme:stm1'),
    stm2: machineId('acme:stm2'),
    stm3: machineId('acme:stm3'),
  },
  jia: {
    id: customerId('jia'),
    plant: siteId('jia:plant'),
    workshop: siteId('jia:workshop'),
    planner: contactId('jia:planner'),
    foreman: contactId('jia:foreman'),
    cnc01: machineId('jia:cnc01'),
    cnc02: machineId('jia:cnc02'),
    lathe01: machineId('jia:lathe01'),
  },
  pmg: {
    id: customerId('pmg'),
    head: siteId('pmg:head'),
    plant: siteId('pmg:plant'),
    engineer: contactId('pmg:engineer'),
    cnc01: machineId('pmg:cnc01'),
    grinder: machineId('pmg:grinder'),
  },
  ams: {
    id: customerId('ams'),
    head: siteId('ams:head'),
    workshop: siteId('ams:workshop'),
    manager: contactId('ams:manager'),
    controller: contactId('ams:workshop'),
    cnc01: machineId('ams:cnc01'),
  },
  sic: {
    id: customerId('sic'),
    factory: siteId('sic:factory'),
    buyer: contactId('sic:buyer'),
    press: machineId('sic:press'),
  },
} as const;

/** Who put the register together, for the audit trail the seed writes. */
export const REGISTER_AUTHORS = { MASTER, COORDINATOR, TECH1, TECH2 } as const;
