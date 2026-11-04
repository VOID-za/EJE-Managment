import { asChecklistTemplateId, type ChecklistItem, type ChecklistTemplate } from '@/domain';

/**
 * ============================================================================
 * THE BUSINESS'S THREE CHECKLISTS, EXACTLY AS THE SOURCE DOCUMENTS PRINT THEM.
 * CHK-SRC-1, 4 November 2026.
 * ============================================================================
 *
 * Transcribed from the scans in `docs/source-checklists/` — installation.pdf,
 * service-milling.pdf and service-lathe.pdf, two pages each — and recorded for
 * a person to check line by line in `docs/source-checklists/TRANSCRIPTION.md`.
 * Wording, spelling ("tention", "Checkoil", "MAINTENACE"), capitals, numbering
 * and order are the source's own; nothing is corrected, merged or added. A
 * "\n" marks a line the source starts on its own (a condition such as
 * "APC (if fitted)", a parenthesised instruction, a stacked list).
 *
 * THESE ROWS ARE WRITTEN TO POSTGRESQL BY MIGRATION 0051, not by the seed: they
 * are production data. The ids are fixed (UUID v5 under a namespace of their
 * own, not the demonstration seed's), so this module, the migration and every
 * database agree on them; `source-checklists.db.test.ts` proves the migrated
 * rows equal this module, and `source-checklists.test.ts` proves this module
 * equals the transcription record.
 *
 * Every row is answered Pass / Fail / N/A with a comment, as the paper's tick
 * and Comments columns are; N/A is how "(if fitted)" and "(By request only)"
 * rows are answered. The labelled blanks (R/S/T, Bar/PSI, On/Off time, KPA)
 * are recorded as typed and are never required — the paper does not require
 * them.
 */

export const SOURCE_CHECKLIST_VERSION = '1.0';

const item = (
  id: string,
  number: string,
  text: string,
  extra: Partial<Pick<ChecklistItem, 'group' | 'fields' | 'sourceNote'>> = {},
): ChecklistItem => ({
  id,
  text,
  helpText: '',
  responseType: 'pass_fail_na',
  required: true,
  photoRequired: false,
  unit: null,
  expectedRange: null,
  number,
  group: extra.group ?? '',
  fields: extra.fields ?? [],
  sourceNote: extra.sourceNote ?? '',
});

/** When the transcription was published; the migration stamps the same instant. */
const PUBLISHED_AT = '2026-11-04T12:00:00.000Z';

export const installationChecklist: ChecklistTemplate = {
  id: asChecklistTemplateId('69479130-a5bf-5041-a6ef-eb91dddab44b'),
  name: 'Installation',
  description: 'The WD Hearn Installation Procedure, transcribed exactly from docs/source-checklists/installation.pdf (2 pages).',
  jobTypeCode: 'installation',
  version: SOURCE_CHECKLIST_VERSION,
  status: 'current',
  sourceDocument: 'docs/source-checklists/installation.pdf — WD Hearn Machine Tools "Installation Procedure", 2 pages',
  updatedAt: PUBLISHED_AT,
  kind: 'installation',
  selectionLabel: '',
  layout: {
    title: 'Installation Procedure',
    letterhead: 'WD Hearn Machine Tools — Established 1937',
    headerFields: [
      { label: 'QT #', source: 'quote_number' },
      { label: 'INV #', source: 'invoice_number' },
      { label: 'Company name:', source: 'customer' },
      { label: 'Company address:', source: 'site_address' },
      { label: 'Customer name:', source: 'contact' },
      { label: 'Machine make:', source: 'machine_make' },
      { label: 'Machine model:', source: 'machine_model' },
      { label: 'Machine control:', source: 'machine_control' },
      { label: 'Serial no:', source: 'serial_number' },
      { label: 'Installation date:', source: 'date' },
    ],
    columns: { number: '', description: 'Procedure', tick: '✓', comments: 'Comments' },
    notes: [
      'Please hand in all documents to Juanita & e-mail XML/backup/maintenance file to jhb@wdhearn.co.za',
      'If procedure is not filled in and correctly filled in, no training will be scheduled.',
    ],
    closing: '',
    signatures: [
      { label: 'Engineer (print name)', role: 'engineer_name' },
      { label: 'Engineer Signature', role: 'engineer_signature' },
      { label: 'Customer (print name)', role: 'customer_name' },
      { label: 'Customer Signature', role: 'customer_signature' },
    ],
  },
  sections: [
    {
      id: '750e8c83-1c5f-5162-a21c-d8035db5423d',
      title: '',
      description: '',
      items: [
        item('231fd438-4b20-5a13-b1be-36a221cafc46', '1', 'Tightness check on all electrical connections'),
        item('f59a9e7a-1331-51c0-81b1-07019a1a8dc4', '2', 'Check electrical voltage', { fields: [
  { id: 'r', label: 'R', unit: '' },
  { id: 's', label: 'S', unit: '' },
  { id: 't', label: 'T', unit: '' },
] }),
        item('34d5e414-5c5d-5655-90c0-bd487442fc8d', '3', 'Check electrical voltage - Transformer', { fields: [
  { id: 'r', label: 'R', unit: '' },
  { id: 's', label: 'S', unit: '' },
  { id: 't', label: 'T', unit: '' },
] }),
        item('91800a4f-cce1-5df5-8118-32ef432b8fcd', '4', 'Check 24V'),
        item('1e8e223e-db28-57d7-bb28-330a51cb9599', '5', 'Lubrication pressure', { fields: [
  { id: 'value', label: '', unit: 'Bar/PSI' },
] }),
        item('be92b494-e041-5b5a-99cb-05031dc281b3', '6', 'Lubrication cycle', { fields: [
  { id: 'on_time', label: 'On time:', unit: '' },
  { id: 'off_time', label: 'Off time:', unit: '' },
] }),
        item('ea146031-4be1-5194-babd-ad6fbfb240df', '7', 'Hydraulic Oil', { group: 'Check all oil levels:' }),
        item('b34f33fa-9ffd-57fd-9b87-b73de0a53703', '7', 'Chiller Unit Oil', { group: 'Check all oil levels:' }),
        item('f07aadea-e802-5150-ab2d-3b888ac45a94', '7', 'Turret Oil', { group: 'Check all oil levels:' }),
        item('d6122b64-0f07-5ea8-ad23-cfadb4347c76', '7', 'Tool Arm gearbox Oil', { group: 'Check all oil levels:' }),
        item('6207d959-c288-52da-be55-bc9f578ad40e', '7', 'Air Lube Oil', { group: 'Check all oil levels:' }),
        item('029ccc84-77eb-54a3-a06b-b3111f7352eb', '7', 'Lubrication Oil', { group: 'Check all oil levels:' }),
        item('cd059077-f66b-5ebd-9448-76b852ee0eb8', '8', 'Phase rotation (rotation of all motors)'),
        item('bbf5a058-6dd7-5b3a-9e51-1a2f7a6ee801', '9', 'Check general condition of the machine'),
        item('c9760f82-9585-51fe-aa41-2068cf4b2be3', '10', 'Level the machine'),
        item('eccfcfe7-4c2d-529c-bef7-1b383c082a4a', '11', 'Trepan the table from the spindle and adjust the leveling bolts'),
        item('d00094c8-1431-578c-944a-5b1fb71b3856', '12', 'Check hydraulic pump pressure', { fields: [
  { id: 'value', label: '', unit: 'KPA/PSI' },
] }),
        item('7fce09d8-ea8e-5d12-a896-71ebfcb41c96', '13', 'Check lubrication pressure', { fields: [
  { id: 'value', label: '', unit: 'KPA/PSI' },
] }),
        item('5d8d1ba7-53ac-5a42-a790-1acfc3f48554', '14', 'Check air pressure', { fields: [
  { id: 'value', label: '', unit: 'KPA' },
] }),
        item('e481802b-f500-5d95-a5cb-22f48f4c02e4', '15', 'Check and adjust the positive air pressure from the spindle nose', { fields: [
  { id: 'value', label: '', unit: 'KPA (0.2)' },
] }),
        item('7ff105f4-e45c-51bd-bb9a-544597953f0d', '16', 'Check all axis reference position'),
        item('35caf0b7-797b-59dd-bd67-10feb00b22e7', '17', 'Check the Z axis tool change position'),
        item('34984a9f-7464-5b6b-9c5b-26dccb3befe0', '18', 'Check spindle orientation'),
        item('26f2b1f0-ead3-5338-b800-82ae1df2680f', '19', 'Do a actual tool change with 2 tool holders'),
        item('b1987646-53ac-5eec-9850-82ca790b914e', '20', 'Make sure all the covers are fitted correctly with all the screws'),
        item('6bf4f1e8-b7ee-5556-b540-0f6947ad08aa', '21', 'Test that the lubrication pump works in auto mode (move any axis)'),
        item('cb6408cb-2f73-5ee9-9288-ffd3ba201652', '22', 'Test the coolant system and check for leaks'),
        item('8843894a-2cef-52c8-9c6a-22be543b9e29', '23', 'Run the spindle in (start at 500rpm and increase 500 rpm every 30 minutes)'),
        item('e4c924bd-a223-5bac-96ee-80dcc91d3501', '24', 'Spindle Bearing Test'),
        item('e546637e-2f0e-5d96-b593-f479befa69ff', '25', 'Belt Tension Test'),
        item('be1347ff-a987-5228-a0e7-6bd9f24714db', '26', 'Make copies of the CD disks'),
        item('51bd04b3-22fa-5f54-88c7-a0b9fd8fa1b4', '27', 'Check the manuals and data sheet with the customer and ask for a signature'),
        item('55385383-3546-5e0f-b4c9-e5c147248697', '28', 'Check the parts and tool list with the customer and ask for a signature'),
        item('a06e5077-b4bb-5b9c-a73b-ac46d02fe517', '29', 'Fill in the warranty service note'),
        item('a679adc5-98e8-57d4-9a12-bbc6f37fffad', '30', 'Fanuc Warranty Screenshot'),
        item('d23b733b-29a7-5558-89fa-3cb64a647062', '31', 'Download a maintenance file/back up\nIf Siemens: Extract XML File'),
      ],
    },
  ],
};

export const millingServiceChecklist: ChecklistTemplate = {
  id: asChecklistTemplateId('fc0f1a1f-c0f3-5a40-89b6-adc18e8ac24f'),
  name: 'Service — Milling Machine',
  description: 'The Preventative Maintenance Checklist - Machining Centre, transcribed exactly from docs/source-checklists/service-milling.pdf (2 pages).',
  jobTypeCode: 'service',
  version: SOURCE_CHECKLIST_VERSION,
  status: 'current',
  sourceDocument: 'docs/source-checklists/service-milling.pdf — "Preventative Maintenance Checklist - Machining Centre", 2 pages',
  updatedAt: PUBLISHED_AT,
  kind: 'service_milling',
  selectionLabel: 'Milling Machine / Machining Centre',
  layout: {
    title: 'PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE',
    letterhead: '',
    headerFields: [
      { label: 'CUSTOMER:', source: 'customer' },
      { label: 'MACHINE MAKE:', source: 'machine_make' },
      { label: 'MACHINE MODEL:', source: 'machine_model' },
      { label: 'SERIAL NUMBER:', source: 'serial_number' },
      { label: 'DATE:', source: 'date' },
    ],
    columns: { number: 'OP', description: 'DESCRIPTION', tick: '', comments: 'COMMENTS / NOTES' },
    notes: [],
    closing: 'ALL CHECKS COMPLETE',
    signatures: [
      { label: 'ENGINEER (PRINT NAME)', role: 'engineer_name' },
      { label: 'CUSTOMER (PRINT NAME)', role: 'customer_name' },
      { label: 'ENGINEER (SIGNATURE)', role: 'engineer_signature' },
      { label: 'CUSTOMER (SIGNATURE)', role: 'customer_signature' },
    ],
  },
  sections: [
    {
      id: '15b7ee30-18c8-570e-9dbc-c0ac4e028b35',
      title: 'GENERAL',
      description: '',
      items: [
        item('5cc36982-6647-54a2-8fad-dcd07ecfb53d', '1', 'Check machine level, squareness of slideways, spindle alignment and runout.\n(By request only prior to visit)'),
        item('fd31b80b-95b3-5962-907e-36d4b9c36d65', '2', 'Check and adjust X,Y,Z-Axis Backlash compensation'),
        item('b2aa7d72-789f-54d9-8015-4c9031e635fb', '3', 'Check X,Y, Z Axis zero return.\n(adjust if required by customer)'),
        item('cd91bb91-9b58-56de-b683-aa2827211ea8', '4', 'Check telescopic slide way guards and wipers'),
        item('80f096d7-71ca-5891-8206-0df4a71cf106', '5', 'Check tool unclamp stroke'),
        item('106f6f67-ca08-5513-8ae2-4aa3722969e8', '6', 'Check collet on end of draw bar'),
        item('abe67997-3468-55e1-be38-99c79192e0f8', '7', 'Check ATC function, check fingers and pockets for wear. Check for play in tool lock release mechanism'),
        item('c1cf107f-e915-58b9-ae0c-ce13c9cbc2d0', '8', 'Check for bearing noise X, Y, Z Axis'),
        item('f7b654c6-c3cb-5615-8cdb-1035308e6484', '9', 'Check for bearing noise spindle'),
        item('2f8136f2-daaa-5300-9333-f57c2f8f5f47', '10', 'Check for oil and air leaks'),
        item('d0c05ef9-7260-53b0-a54f-82c670270f12', '11', 'Check linear rail wipers for wear'),
        item('13f749c3-be2e-5360-b544-cd628bb4ae90', '12', 'Check Spindle Orientation'),
        item('ce5386a7-5f87-5eb1-886e-5e4a7ee65927', '13', 'Check Spindle Drive belt for wear and tention'),
        item('69bd74ba-38a2-56e3-bb40-7025ea5f2a1b', '14', 'APC (if fitted)\nCheck accuracy of APC and check clamping faces for wear'),
      ],
    },
    {
      id: '45ff9f87-9ce9-5217-ab50-f6cf56be800e',
      title: 'ELECTRICAL',
      description: '',
      items: [
        item('a68346e1-bfce-5246-a782-9d43a9bc8b2b', '1', 'Check main supply voltage'),
        item('9922623d-5936-5d2f-9eeb-015fc26f3417', '2', 'Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc.'),
        item('c6f0e42c-e721-570e-933e-3d7b36e359a6', '3', 'Check work lamp and indicator lamps'),
        item('b760cadd-b992-53e4-b897-c91e1d3654ee', '4', 'Check push button and switches'),
        item('f45f5ee7-fe78-5792-8472-96247dbbd898', '5', 'Check function of each emergency stop'),
        item('94b178c0-1be4-5060-9f8b-c97179688699', '6', 'Check function of door locks and interlocks'),
        item('88958581-57ac-5a27-99cc-59c6ec74594d', '7', 'Check for dirt, oil in electrical control cabinets and advise how to clean if required'),
        item('949f8d86-f6c3-5e10-b358-6bd50e03c63c', '8', 'Clean electrical cabinet filters and fans'),
        item('077ad951-1ae3-5daf-946c-3ec3dcd7046b', '9', 'Check & clean electrical motor fans'),
        item('99bce411-d10a-53e6-a2a4-28612ecaa768', '10', 'Check external cables for damage'),
        item('972af260-3e3e-5825-ab3d-9cb1dc7b8c46', '11', 'Replaced FANUC control battery'),
      ],
    },
    {
      id: '9bb88447-f159-56e4-9da0-12cb98b8ebb5',
      title: 'LUBRICATION',
      description: '',
      items: [
        item('fc849abe-a705-50ce-a01f-0cb848e6d290', '1', 'Clean spindle lube tank, Change oil, clean/replace filters.'),
        item('dc21582d-4e9a-5749-99b6-d459866f4537', '2', 'Check Lubrication pump pressure'),
        item('b2842d8a-5f57-53e4-9283-11f46ed97bc4', '3', 'Check that there is oil on the ballscrews and linear ways'),
        item('75660b63-17d1-5126-9a69-48ea0b48c79f', '4', 'Check ATC box oil'),
      ],
    },
    {
      id: '49e134a6-f401-53a3-b7a4-a0cea6438b17',
      title: 'HYDRAULICS',
      description: '',
      items: [
        item('a4113b22-5482-50ce-ac68-8f9305c4ed23', '1', '(if Fitted APC)\na. Clean hydraulic tank and filter, change oil b. Check hydraulic pressure settings'),
        item('751278eb-d8e7-5ceb-b099-3d8a027a49d2', '2', 'SPINDLE OIL COOLER Checkoil and check air filters. Airblast clean the condenser cooling fans'),
      ],
    },
    {
      id: 'deb57fa5-b93e-5ea9-92ea-6fbabcefc2d7',
      title: 'PNEUMATICS',
      description: '',
      items: [
        item('7addb236-3f09-5acf-a85a-cf037cbe8321', '1', 'Clean air/oil units and clean/replace filters'),
        item('be25e5ed-8c03-58c1-9985-2ea909b3c26d', '2', 'Check and Adjust air/oil pressures if necessary'),
        item('5a17af54-50ea-5304-8f36-71dd53573e45', '3', 'Check for air blast at ATC'),
      ],
    },
    {
      id: 'da86a7a1-22df-5f03-8ae2-55a41a5d364c',
      title: 'COOLANT',
      description: '',
      items: [
        item('91c359ae-52ba-58a9-8920-f043ad624334', '1', 'Check filters'),
        item('121e32f7-79d4-5666-9203-f08c8a246817', '2', 'Clean Grids'),
        item('dbc9fc3c-f40a-5b28-a1db-300d34f0e8d3', '3', 'Clean Tank'),
      ],
    },
    {
      id: '32f4c4e8-8f74-5697-8143-a7f840fe905a',
      title: 'BACK UP',
      description: '',
      items: [
        item('66b788a4-5c77-53dd-ab3f-e9e4a52304fb', '1', 'Make Machine Back up'),
      ],
    },
    {
      id: 'a6436f4f-3e70-5c6c-9d3a-6175708c05b9',
      title: 'THERMAL CHECK',
      description: '',
      items: [
        item('70a16417-643b-5e9f-bb02-a0313d756131', '1', 'Picture Machine when running Electrical Panel and Motors'),
      ],
    },
  ],
};

export const latheServiceChecklist: ChecklistTemplate = {
  id: asChecklistTemplateId('a664c9a7-e7c9-527b-b920-d02c6bd7313f'),
  name: 'Service — Lathe',
  description: 'The Preventative Maintenace Checklist - Lathe, transcribed exactly from docs/source-checklists/service-lathe.pdf (2 pages), including its handwritten addition.',
  jobTypeCode: 'service',
  version: SOURCE_CHECKLIST_VERSION,
  status: 'current',
  sourceDocument: 'docs/source-checklists/service-lathe.pdf — "Preventative Maintenace Checklist - Lathe", 2 pages, one handwritten addition',
  updatedAt: PUBLISHED_AT,
  kind: 'service_lathe',
  selectionLabel: 'Lathe',
  layout: {
    title: 'PREVENTATIVE MAINTENACE CHECKLIST - LATHE',
    letterhead: '',
    headerFields: [
      { label: 'CUSTOMER:', source: 'customer' },
      { label: 'MACHINE MAKE:', source: 'machine_make' },
      { label: 'MACHINE MODEL:', source: 'machine_model' },
      { label: 'SERIAL NUMBER:', source: 'serial_number' },
      { label: 'DATE:', source: 'date' },
    ],
    columns: { number: 'OP', description: 'DESCRIPTION', tick: '', comments: 'COMMENTS / NOTES' },
    notes: [],
    closing: '',
    signatures: [
      { label: 'ENGINEER (SIGNATURE)', role: 'engineer_signature' },
      { label: 'CUSTOMER (SIGNATURE)', role: 'customer_signature' },
    ],
  },
  sections: [
    {
      id: '82300267-67a6-5f4b-9ee3-6cc472e7b6d6',
      title: 'GENERAL',
      description: '',
      items: [
        item('9babe6bd-d5fa-5ac8-93e2-3f7727d35f2a', '1', 'Check machine level, Requires levelling plate\n(By request only prior to visit)'),
        item('3374966c-6e7e-5035-a9e8-977fae1ff5c1', '2', 'Check and adjust X,Z-Axis Backlash'),
        item('1111d930-38ca-5b8c-821e-ed87a5a4d7f8', '3', 'Check Spindle Drive belt for wear and deterioration & Tension'),
        item('82ce5d3f-5043-5f08-b8c2-42ec7ba28fee', '4', 'Check X Axis Brake for operation'),
        item('bb2c6e16-7fce-523c-98ac-cae3c187ecdf', '5', 'Check Z Axis drive belts for tention and deterioration'),
        item('69bde05a-403a-5013-a568-969af79809b9', '6', 'Check gear exchange operation'),
        item('20862037-3f4b-54ec-982f-dd7365e8a8cf', '7', 'Check for any oil, air coolant leaks'),
        item('ab6901c2-e0cd-565d-a6b6-4a4a7fa8fb4e', '8', 'Check for bearing noise X, Z Axis\nCheck for bearing noise spindle\nCheck for bearing noise gearbox'),
        item('572a2492-660b-5c74-96f0-a07b62bf94a4', '9', 'Check Z Axis slideway guards and wipers'),
        item('421c2aa1-6bb2-5e26-89a1-7d039499ae58', '10', 'Check X and Z slideway wipers for wear'),
        item('9c9d3b23-69e2-5b66-8c43-a0529c6c68ad', '11', 'Check Turret alignment X and Z Axis'),
        item('107d58ae-9ae1-57c8-805a-65d775427a78', '12', 'Check Turret centerline, adjust if necessary\n(X Axis stroke)'),
        item('43dd1929-e091-55c3-8ee8-7d9cdf00c656', '13', 'Check flexible tracking for wear and deterioration'),
        item('9a07cbde-b801-5f4e-b034-d7ae224e0eb8', '14', 'TAILSTOCK (if fitted)\nCheck condition of revolving centre'),
        item('614f6cd9-6db3-5913-b532-e387e73e7dc1', '15', 'PARTS CATCHER (if fitted)\nCheck for correct operation and damage'),
        item('6b5b8193-1236-542b-b9a0-185a7a1a22e2', '16', 'MANUAL TOOLSETTER (if fitted)\nCheck for damage and recalibrate (customer to supply soft metal billet for recalibration.)'),
        item('a05edd75-e25c-5304-b771-e97f3c626d6f', '17', 'ROTARY TOOL (if fitted)\nCheck Rotary Tool drive on turret'),
        item('fa1c7097-41be-5e1f-9a75-ac2e2462d305', '18', 'ROTARY TOOL (if fitted)\nCheck drive belts for tension and deterioration'),
      ],
    },
    {
      id: 'ac30746d-ad29-56bf-936c-348ec3ba4b53',
      title: 'ELECTRICAL',
      description: '',
      items: [
        item('e2064a77-ce0c-57c3-b1f7-2a0001dd5c91', '1', 'Check main supply voltage'),
        item('ddf715fe-0025-5db7-95e9-68564a3f54c0', '2', 'Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc.'),
        item('12345053-c904-563f-8710-fc0be2b66b16', '3', 'Check work lamp and indicator lamps'),
        item('e6763fc3-5cba-5318-9d72-8ea6ff389983', '4', 'Check push button and switches'),
        item('6df9f58a-d312-5087-aaca-c377e39492b7', '5', 'Check function of each emergency stop'),
        item('49ce73ee-0a1f-5e6f-b583-b8caccd634f3', '', 'Changed Fanuc control battery', { sourceNote: 'Handwritten on the supplied source.' }),
        item('ee376a9a-6336-59ee-9415-e69345be464c', '', 'Check & clean electrical motor fans', { sourceNote: 'Printed in a separate, unnumbered box on the supplied source.' }),
        item('942dd102-1c2b-5db7-8fbf-812b9e61748b', '6', 'Check function of door locks and interlocks'),
        item('cf6b0dc0-1161-5b77-8868-60c3aedefc0c', '7', 'Check and adjust spindle load monitor'),
        item('a70109e9-6022-553c-a88a-340f990268b6', '8', 'Check for dirt, oil in electrical control cabinets and advise how to clean if required'),
        item('aef05be5-b560-5368-a12c-e78aa5e5b9d5', '9', 'Clean electrical cabinet filters and fans'),
        item('913edb74-5f49-5f36-8cb3-611fcb6bae6a', '10', 'Check external cables for damage'),
      ],
    },
    {
      id: '658b4de6-4d47-59c4-9cbc-9928948e7ec1',
      title: 'LUBRICATION',
      description: '',
      items: [
        item('0bc75f56-8cfa-5ca3-a317-813cd3871cd8', '1', 'Clean auto lube tank and port filter, Change oil, clean/replace suction filter.'),
        item('d719761d-d7be-5e1b-90d6-b6c1722db7a6', '2', 'Check Lubrication pump pressure'),
        item('7655a07c-ebf8-5432-88ca-c3565f227e4c', '3', 'Check for oil appearing on slideways and ballscrews'),
      ],
    },
    {
      id: '4a99f739-7b1b-58fd-8d0c-2ab0b12c0abf',
      title: 'HYDRAULICS',
      description: '',
      items: [
        item('361a890e-9aca-5a19-bc41-24b5fc7643d8', '1', 'Clean Hydraulic tank and filter. Change oil'),
        item('5ec2fa86-c43d-5f16-9bea-26c7716317bf', '2', 'Check Tailstock pressure, chucking pressure and main pressure gauges for correct operation and damage'),
        item('f25383e2-3ff5-5704-b1e0-71c2c7d05ea1', '3', 'Check Chuck clamp/unclamp working correctly'),
        item('4216dfd4-11c8-5659-8023-1f618ffc4fa9', '4', 'SPINDLE OIL COOLER Clean tank and filter, change oil and check air filters'),
      ],
    },
    {
      id: 'b4372cc6-ffb6-5e23-bc74-8589555b91ea',
      title: 'PNEUMATICS',
      description: '',
      items: [
        item('75198204-37b3-5c27-a0c9-a3e4e4eb8dd8', '1', 'Clean air/oil units and clean/replace filters'),
        item('f7dfce06-3e5c-59c3-9f11-c5291624c4b7', '2', 'Check air gauges and pressure adjust if necessary'),
      ],
    },
    {
      id: '35fbc773-0360-5805-828b-c881376f3a09',
      title: 'BACK UP',
      description: '',
      items: [
        item('170d53a9-6523-59a7-87f0-48676d30e39c', '1', 'Make Machine Back up'),
      ],
    },
    {
      id: '0bca6ac4-93c8-56e7-8546-be9d316a0263',
      title: 'THERMAL CHECK',
      description: '',
      items: [
        item('4bdbbd96-54aa-5dda-86e4-ef86912d1f4f', '1', 'Picture Machine when running Electrical Panel and Motors'),
      ],
    },
  ],
};

/** Installation, Service — Milling Machine, Service — Lathe, in that order. */
export const sourceChecklists: readonly ChecklistTemplate[] = [
  installationChecklist,
  millingServiceChecklist,
  latheServiceChecklist,
];
