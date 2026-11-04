# Source checklists — transcription record (CHK-SRC-1)

Transcribed on 4 November 2026 from the scans in this folder. Each PDF is a
phone scan of two printed pages (one image per page, no text layer). This file
is what the application holds, row for row: `src/data/checklists/source-checklists.ts`
is tested against it (`source-checklists.test.ts`), and the migrated database
rows are tested against that module (`source-checklists.db.test.ts`).

**For the owner:** check each table against the paper. Wording, spelling,
capitals, numbering and order are kept exactly as printed — including the
source's own spellings ("tention", "Checkoil", "MAINTENACE", "Do a actual").
`<br>` marks a line the source starts on its own.

## Points of interpretation — please confirm

1. **Lathe, Electrical items 6–10 (page 2).** The scan of page 2 is cut off on
   the left, so these five numbers are not visible; only the right edge of the
   last ("…0") shows. They are numbered 6–10 continuing page 1's 1–5. If the
   paper numbers them differently, say so and a new version will carry it.
2. **Lathe, the handwritten addition.** Below Electrical item 5 the paper
   carries the handwritten words **"Changed Fanuc control battery"**, above a
   separate small printed box, **"Check & clean electrical motor fans"**, which
   has no number. Both are kept, in that order, as unnumbered rows; the first
   is marked *Handwritten on the supplied source*, the second *Printed in a
   separate, unnumbered box*. The faint writing at the foot of page 2 is the
   same handwriting pressed through the paper — it is not separate content.
3. **Installation, item 7** prints "Check all oil levels:" once beside six
   oils, each with its own tick and comment. It is six rows numbered 7 under
   that heading: 31 numbered procedures, 36 rows to answer.
4. **Installation, items 12–15 (page 2).** The photograph is skewed; the four
   units in the Comments column are read as belonging to items 12 (KPA/PSI),
   13 (KPA/PSI), 14 (KPA) and 15 (KPA (0.2)).
5. **How each row is answered.** The paper has a tick column and a Comments
   column. Each row is answered **Pass / Fail / N/A** with an optional comment
   (a Fail needs one); "(if fitted)" and "(By request only …)" rows are
   answered N/A when they do not apply. The printed blanks (R / S / T, Bar/PSI,
   On time / Off time, KPA) are typed in and are not compulsory.
6. **Header and sign-off.** The printed header lines (company, machine, serial,
   date, QT #, INV #) are filled from the job. The engineer's and customer's
   names and signatures are the job's own: the customer signs once, on the job
   card, which carries this checklist.

## Installation

- **Source:** docs/source-checklists/installation.pdf — WD Hearn Machine Tools "Installation Procedure", 2 pages
- **Printed title:** Installation Procedure
- **Letterhead:** WD Hearn Machine Tools — Established 1937
- **Header lines:** QT # · INV # · Company name: · Company address: · Customer name: · Machine make: · Machine model: · Machine control: · Serial no: · Installation date:
- **Columns:** (blank) · Procedure · ✓ · Comments
- **Rows:** 36 (numbered entries: 31)

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Tightness check on all electrical connections |  |  |
| 2 |  | Check electrical voltage | R ___ · S ___ · T ___ |  |
| 3 |  | Check electrical voltage - Transformer | R ___ · S ___ · T ___ |  |
| 4 |  | Check 24V |  |  |
| 5 |  | Lubrication pressure | ___ Bar/PSI |  |
| 6 |  | Lubrication cycle | On time: ___ · Off time: ___ |  |
| 7 | Check all oil levels: | Hydraulic Oil |  |  |
| 7 | Check all oil levels: | Chiller Unit Oil |  |  |
| 7 | Check all oil levels: | Turret Oil |  |  |
| 7 | Check all oil levels: | Tool Arm gearbox Oil |  |  |
| 7 | Check all oil levels: | Air Lube Oil |  |  |
| 7 | Check all oil levels: | Lubrication Oil |  |  |
| 8 |  | Phase rotation (rotation of all motors) |  |  |
| 9 |  | Check general condition of the machine |  |  |
| 10 |  | Level the machine |  |  |
| 11 |  | Trepan the table from the spindle and adjust the leveling bolts |  |  |
| 12 |  | Check hydraulic pump pressure | ___ KPA/PSI |  |
| 13 |  | Check lubrication pressure | ___ KPA/PSI |  |
| 14 |  | Check air pressure | ___ KPA |  |
| 15 |  | Check and adjust the positive air pressure from the spindle nose | ___ KPA (0.2) |  |
| 16 |  | Check all axis reference position |  |  |
| 17 |  | Check the Z axis tool change position |  |  |
| 18 |  | Check spindle orientation |  |  |
| 19 |  | Do a actual tool change with 2 tool holders |  |  |
| 20 |  | Make sure all the covers are fitted correctly with all the screws |  |  |
| 21 |  | Test that the lubrication pump works in auto mode (move any axis) |  |  |
| 22 |  | Test the coolant system and check for leaks |  |  |
| 23 |  | Run the spindle in (start at 500rpm and increase 500 rpm every 30 minutes) |  |  |
| 24 |  | Spindle Bearing Test |  |  |
| 25 |  | Belt Tension Test |  |  |
| 26 |  | Make copies of the CD disks |  |  |
| 27 |  | Check the manuals and data sheet with the customer and ask for a signature |  |  |
| 28 |  | Check the parts and tool list with the customer and ask for a signature |  |  |
| 29 |  | Fill in the warranty service note |  |  |
| 30 |  | Fanuc Warranty Screenshot |  |  |
| 31 |  | Download a maintenance file/back up<br>If Siemens: Extract XML File |  |  |

**Printed notes:**

- Please hand in all documents to Juanita & e-mail XML/backup/maintenance file to jhb@wdhearn.co.za
- If procedure is not filled in and correctly filled in, no training will be scheduled.

**Sign-off:** Engineer (print name) · Engineer Signature · Customer (print name) · Customer Signature

## Service — Milling Machine

- **Source:** docs/source-checklists/service-milling.pdf — "Preventative Maintenance Checklist - Machining Centre", 2 pages
- **Printed title:** PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE
- **Service choice:** Milling Machine / Machining Centre
- **Header lines:** CUSTOMER: · MACHINE MAKE: · MACHINE MODEL: · SERIAL NUMBER: · DATE:
- **Columns:** OP · DESCRIPTION · (blank) · COMMENTS / NOTES
- **Rows:** 39 (numbered entries: 14)

### GENERAL

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Check machine level, squareness of slideways, spindle alignment and runout.<br>(By request only prior to visit) |  |  |
| 2 |  | Check and adjust X,Y,Z-Axis Backlash compensation |  |  |
| 3 |  | Check X,Y, Z Axis zero return.<br>(adjust if required by customer) |  |  |
| 4 |  | Check telescopic slide way guards and wipers |  |  |
| 5 |  | Check tool unclamp stroke |  |  |
| 6 |  | Check collet on end of draw bar |  |  |
| 7 |  | Check ATC function, check fingers and pockets for wear. Check for play in tool lock release mechanism |  |  |
| 8 |  | Check for bearing noise X, Y, Z Axis |  |  |
| 9 |  | Check for bearing noise spindle |  |  |
| 10 |  | Check for oil and air leaks |  |  |
| 11 |  | Check linear rail wipers for wear |  |  |
| 12 |  | Check Spindle Orientation |  |  |
| 13 |  | Check Spindle Drive belt for wear and tention |  |  |
| 14 |  | APC (if fitted)<br>Check accuracy of APC and check clamping faces for wear |  |  |

### ELECTRICAL

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Check main supply voltage |  |  |
| 2 |  | Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc. |  |  |
| 3 |  | Check work lamp and indicator lamps |  |  |
| 4 |  | Check push button and switches |  |  |
| 5 |  | Check function of each emergency stop |  |  |
| 6 |  | Check function of door locks and interlocks |  |  |
| 7 |  | Check for dirt, oil in electrical control cabinets and advise how to clean if required |  |  |
| 8 |  | Clean electrical cabinet filters and fans |  |  |
| 9 |  | Check & clean electrical motor fans |  |  |
| 10 |  | Check external cables for damage |  |  |
| 11 |  | Replaced FANUC control battery |  |  |

### LUBRICATION

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Clean spindle lube tank, Change oil, clean/replace filters. |  |  |
| 2 |  | Check Lubrication pump pressure |  |  |
| 3 |  | Check that there is oil on the ballscrews and linear ways |  |  |
| 4 |  | Check ATC box oil |  |  |

### HYDRAULICS

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | (if Fitted APC)<br>a. Clean hydraulic tank and filter, change oil b. Check hydraulic pressure settings |  |  |
| 2 |  | SPINDLE OIL COOLER Checkoil and check air filters. Airblast clean the condenser cooling fans |  |  |

### PNEUMATICS

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Clean air/oil units and clean/replace filters |  |  |
| 2 |  | Check and Adjust air/oil pressures if necessary |  |  |
| 3 |  | Check for air blast at ATC |  |  |

### COOLANT

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Check filters |  |  |
| 2 |  | Clean Grids |  |  |
| 3 |  | Clean Tank |  |  |

### BACK UP

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Make Machine Back up |  |  |

### THERMAL CHECK

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Picture Machine when running Electrical Panel and Motors |  |  |

**Closing line:** ALL CHECKS COMPLETE

**Sign-off:** ENGINEER (PRINT NAME) · CUSTOMER (PRINT NAME) · ENGINEER (SIGNATURE) · CUSTOMER (SIGNATURE)

## Service — Lathe

- **Source:** docs/source-checklists/service-lathe.pdf — "Preventative Maintenace Checklist - Lathe", 2 pages, one handwritten addition
- **Printed title:** PREVENTATIVE MAINTENACE CHECKLIST - LATHE
- **Service choice:** Lathe
- **Header lines:** CUSTOMER: · MACHINE MAKE: · MACHINE MODEL: · SERIAL NUMBER: · DATE:
- **Columns:** OP · DESCRIPTION · (blank) · COMMENTS / NOTES
- **Rows:** 41 (numbered entries: 18)

### GENERAL

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Check machine level, Requires levelling plate<br>(By request only prior to visit) |  |  |
| 2 |  | Check and adjust X,Z-Axis Backlash |  |  |
| 3 |  | Check Spindle Drive belt for wear and deterioration & Tension |  |  |
| 4 |  | Check X Axis Brake for operation |  |  |
| 5 |  | Check Z Axis drive belts for tention and deterioration |  |  |
| 6 |  | Check gear exchange operation |  |  |
| 7 |  | Check for any oil, air coolant leaks |  |  |
| 8 |  | Check for bearing noise X, Z Axis<br>Check for bearing noise spindle<br>Check for bearing noise gearbox |  |  |
| 9 |  | Check Z Axis slideway guards and wipers |  |  |
| 10 |  | Check X and Z slideway wipers for wear |  |  |
| 11 |  | Check Turret alignment X and Z Axis |  |  |
| 12 |  | Check Turret centerline, adjust if necessary<br>(X Axis stroke) |  |  |
| 13 |  | Check flexible tracking for wear and deterioration |  |  |
| 14 |  | TAILSTOCK (if fitted)<br>Check condition of revolving centre |  |  |
| 15 |  | PARTS CATCHER (if fitted)<br>Check for correct operation and damage |  |  |
| 16 |  | MANUAL TOOLSETTER (if fitted)<br>Check for damage and recalibrate (customer to supply soft metal billet for recalibration.) |  |  |
| 17 |  | ROTARY TOOL (if fitted)<br>Check Rotary Tool drive on turret |  |  |
| 18 |  | ROTARY TOOL (if fitted)<br>Check drive belts for tension and deterioration |  |  |

### ELECTRICAL

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Check main supply voltage |  |  |
| 2 |  | Check for tightness of magnetic switches, relays, thermal relays, fuses, circuit breakers, servo connectors, terminal, etc. |  |  |
| 3 |  | Check work lamp and indicator lamps |  |  |
| 4 |  | Check push button and switches |  |  |
| 5 |  | Check function of each emergency stop |  |  |
|  |  | Changed Fanuc control battery |  | Handwritten on the supplied source. |
|  |  | Check & clean electrical motor fans |  | Printed in a separate, unnumbered box on the supplied source. |
| 6 |  | Check function of door locks and interlocks |  |  |
| 7 |  | Check and adjust spindle load monitor |  |  |
| 8 |  | Check for dirt, oil in electrical control cabinets and advise how to clean if required |  |  |
| 9 |  | Clean electrical cabinet filters and fans |  |  |
| 10 |  | Check external cables for damage |  |  |

### LUBRICATION

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Clean auto lube tank and port filter, Change oil, clean/replace suction filter. |  |  |
| 2 |  | Check Lubrication pump pressure |  |  |
| 3 |  | Check for oil appearing on slideways and ballscrews |  |  |

### HYDRAULICS

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Clean Hydraulic tank and filter. Change oil |  |  |
| 2 |  | Check Tailstock pressure, chucking pressure and main pressure gauges for correct operation and damage |  |  |
| 3 |  | Check Chuck clamp/unclamp working correctly |  |  |
| 4 |  | SPINDLE OIL COOLER Clean tank and filter, change oil and check air filters |  |  |

### PNEUMATICS

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Clean air/oil units and clean/replace filters |  |  |
| 2 |  | Check air gauges and pressure adjust if necessary |  |  |

### BACK UP

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Make Machine Back up |  |  |

### THERMAL CHECK

| No. | Group | Description | Blanks | Source note |
|---|---|---|---|---|
| 1 |  | Picture Machine when running Electrical Panel and Motors |  |  |

**Sign-off:** ENGINEER (SIGNATURE) · CUSTOMER (SIGNATURE)

