# Setting up WhatsApp, Microsoft 365 email and Google Maps for EJE

**Who this is for:** the EJE business owner and EJE's IT person.
**What it does:** walks through creating the three outside accounts the EJE
system needs. Each section ends with **what you will have at the end**: the
details the developer needs.
**Research date:** every outside fact below was checked against the official
Microsoft, Meta and Google documentation on **1 November 2026**. These companies
change their screens, prices and rules often. Where the official documentation
was unclear, or could not be confirmed, this guide says **verify at setup time**
instead of guessing.

> **Never put a real secret in this document, in an email, in a WhatsApp
> message or in a ticket.** How to hand the details over safely is covered in
> [After you have the details](#5-after-you-have-the-details).

| Part | Service | What EJE uses it for |
|---|---|---|
| [1](#1-whatsapp-choosing-the-phone-number-read-this-first) and [2](#2-whatsapp-business-platform-cloud-api-setup) | Meta WhatsApp Business Platform (Cloud API) | Telling a technician that a job was assigned or transferred to them, and sending them the site location |
| [3](#3-microsoft-365-email-sending-from-salesejeiecoza) | Microsoft 365 (Microsoft Graph) | Sending job cards and other system emails **from** `sales@ejeie.co.za` |
| [4](#4-google-maps-platform-geocoding-api) | Google Maps Platform (Geocoding API) | Turning a typed site address into map coordinates |

The live system runs at `https://eje.syncza.co.za` on EJE's Hostinger VPS, as
the systemd service `eje`. According to `docs/vps-deployment.md`, the
production settings file on the server is **`/etc/eje/eje.env`**. It is owned
by `root`, the `eje` group can read it, and no other user can. The service is
restarted with **`sudo systemctl restart eje`**.

---

## 1. WhatsApp: choosing the phone number (read this first)

### 1.1 The decision: a new, dedicated EJE number (confirmed 1 November 2026)

**The owner has decided: EJE's system notifications use a new WhatsApp number
of their own (option B below), through the Meta Cloud API directly.** The
office's existing WhatsApp number is **not** connected, migrated, registered,
deregistered or changed in any way. The office keeps its WhatsApp Business app,
its linked devices and its chat history exactly as they are.

The dedicated number is a **separate system integration**: in Administration
→ Integrations it is shown as *WhatsApp — dedicated EJE number*, it has its own
settings (`WHATSAPP_DEDICATED_NUMBER` and the Meta credentials for that
number), and it says **Not configured** until those are set **and** a real test
message to an internal number has been accepted by Meta (see 1.6).

> **NEVER migrate, register or deregister the existing office WhatsApp number
> on the Cloud API.** Neither the developer, the IT person nor a Meta partner
> may do this. Reversing the decision above needs a new written decision from
> the owner.

### 1.2 Why not the office number: what Meta's documentation says (checked 1 November 2026)

**Registering a number on the Cloud API *without* coexistence.** Meta's phone
number guide says: *"Numbers already in use with WhatsApp cannot be registered
unless they are deleted first."*
([Meta: Phone numbers](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers))
That means deleting the WhatsApp account on that number in the app. The app
then stops working on that number, and Meta documents no way to carry the app's
chat history over to the Cloud API. Meta's guide also does not document a way
to move a Cloud API number back to the app (**verify at setup time** if this
ever matters). Treat this as a one-way, disruptive change.

**"Coexistence"** connects a number that is in the **WhatsApp Business app** to
the Cloud API, so that both keep working. Source: [Meta: Onboarding WhatsApp
Business app users (coexistence)](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users),
also published at
[this address](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users.md).
The facts:

| Question | What Meta's page says |
|---|---|
| Is it generally available? | Yes. It is a documented, production feature of Embedded Signup. Embedded Signup v2 and v3 were due to be deprecated on 15 October 2026, so a partner must be on v4 or later. On v5 coexistence is on by default. |
| Who can onboard you? | Only through **Embedded Signup run by a Meta Solution Partner or Tech Provider**: *"You must already be a Solution Partner or Tech Provider."* A business cannot switch it on directly in its own developer app. EJE would need a Meta partner (a WhatsApp "BSP"), or would need to become a Tech Provider itself. Becoming a Tech Provider involves Meta business verification and app review. |
| Is South Africa (+27) supported? | **Unclear, so verify at setup time.** On 1 November 2026, Meta's current page **lists no unsupported countries**. Earlier versions of Meta's developer documentation, quoted by partners as recently as March 2026, listed **Nigeria and South Africa** as unsupported country codes. Partner sites report that South Africa was added during 2026 (e.g. [Chakra](https://chakrahq.com/article/whatsapp-coexistence-live-eu-uk-europe-whatsapp-business-for-api-live/)), but those are not official Meta sources. Ask the partner to confirm in writing that a +27 number can be onboarded with coexistence today. |
| Which app? | Only the **WhatsApp Business app**, *version 2.24.17 or higher*. The page describes onboarding only "using their existing WhatsApp Business app account and phone number". It says nothing about the ordinary (personal) WhatsApp app. **Assume a personal WhatsApp number cannot use coexistence.** |
| Must the number have been active for a minimum time? | Meta's current page sets **no minimum-age rule**. (Some partners state one. Ask the partner.) After onboarding, the business has **24 hours** to share its data, otherwise it must offboard and start again. |
| Chat history | Up to **6 months** of **one-to-one** chats can be synced, but only if the business agrees to share history. **Group chats are not synced.** Media from the last 14 days only. |
| Linked devices | **All linked (companion) devices are unlinked** when you onboard. Supported ones can be linked again. **WhatsApp for Windows and WhatsApp for WearOS are not supported**, and messages sent from unsupported devices are not seen by the API. |
| Features that stop working in the app | **Broadcast lists** are disabled: you cannot create new ones, and existing ones become read-only. **Disappearing messages, view-once messages and live location** are turned off for one-to-one chats. |
| Features the API cannot use | Group chats, voice and video calls, catalogue and orders, status, greeting and away messages, quick replies, labels, Channels. Groups still exist in the app, but they are not synced to the API. |
| Throughput | A coexistence number has *"a fixed throughput of 20 mps"* (messages per second). That is far more than EJE needs. |
| Inactivity | The number is disconnected if the phone with the app is inactive for about **14 days**, or a companion device for about **30 days**. |
| Disconnecting | In the WhatsApp Business app: **Settings → Account → Business Platform → Disconnect Account**. The Cloud API "Deregister" call **cannot** be used on coexistence numbers. |
| Cost | Messages sent from the app stay free. Messages sent through the API are billed at normal Cloud API rates. |

### 1.3 The three options

| | (A) Coexistence on the existing office number | (B) A **new, dedicated number** for the system | (C) Full migration of the existing office number |
|---|---|---|---|
| Office keeps using the app on its number | Yes, with the limits in 1.2 | Yes, completely unchanged | **No**, the app stops working on that number |
| Chat history | Last 6 months of one-to-one chats (optional sync), no groups | Untouched | Not migrated |
| Linked devices / WhatsApp for Windows | All unlinked. Windows not supported | Untouched | Lost |
| Broadcast lists, view-once, disappearing messages | Disabled | Untouched | Lost |
| Needs a Meta partner (BSP) or Tech Provider status | **Yes** | No. EJE's own developer app is enough | No |
| South Africa supported | **Verify at setup time** | Yes | Yes |
| Risk of disrupting the office | Medium | **None** | High |
| Reversible | Yes (Disconnect Account in the app) | Yes | Not documented, so assume not |

### 1.4 Why option B

It is the safest supported setup. Nothing the office does today changes, EJE's own developer
app can register it directly without a third-party partner, and it can be
tested without risk. Technicians save it as "EJE Jobs". The messages EJE sends
are notifications, so the number does not have to be the one customers know.

The number must be able to receive an SMS or a voice call for verification. A
new SIM, or a landline that can receive a call, both work. It must **not**
already be registered on any WhatsApp app (or the account on it must be
deleted first). Short codes are not supported. Source: [Meta: Phone
numbers](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers).

Options A and C are **not** being used. Choosing one later would need a new
written decision from the owner, a Meta partner's written confirmation that
+27 coexistence is available (option A), and the checklist in 1.5.

### 1.5 Pre-flight checklist (only if the owner ever reverses the decision)

- [ ] The owner has decided, in writing, which option and which number.
- [ ] Confirm the number is on the **WhatsApp Business app**, not the personal
      WhatsApp app. In the app, **Settings** shows "Business tools" only in the
      Business app.
- [ ] Update the WhatsApp Business app to **2.24.17 or newer** on the main phone.
- [ ] **Back up the chats** (Settings → Chats → Chat backup, to Google Drive or
      iCloud). Export any chat that matters for records.
- [ ] Write down every linked device (Settings → Linked devices). Anyone using
      **WhatsApp for Windows** must be told it will stop working with this
      number, and should switch to WhatsApp Web or the Mac app if supported
      (**verify at setup time**).
- [ ] Write down the broadcast lists in use. They become read-only.
- [ ] Choose a quiet time, and tell the office ladies what will change.
- [ ] Confirm the partner's process for **disconnecting** before you start.
- [ ] The main phone must stay in use. Fourteen days of inactivity disconnects it.

### 1.6 How EJE keeps the office number out

These protections are in the code, so a typing mistake cannot put the office
number to work:

1. **The dedicated number must be named.** Without `WHATSAPP_DEDICATED_NUMBER`
   (a full number with the country code), WhatsApp counts as not configured
   and nothing is sent.
2. **Meta is asked before sending.** Before the first message (and again every
   six hours) EJE asks Meta which number the configured phone number ID
   belongs to. If it is not the dedicated number, nothing is sent and the
   office sees why.
3. **The office number can be protected by name.** List it in
   `WHATSAPP_PROTECTED_NUMBERS`. EJE then refuses to start if it is set as the
   dedicated number, and refuses to send if Meta reports it as the sender.
4. **Read-only towards Meta's number settings.** EJE only ever *reads* the
   number's details and *sends* approved template messages. It has no code to
   register, deregister, migrate or change a number, and a test checks that.
5. **Not in use until a real test passes.** Until a test message to a number
   in `WHATSAPP_TEST_RECIPIENTS` is accepted by Meta *with the current
   settings*, the status is **Not configured** and no job notification is sent
   (assignments and transfers still work and notify in the app). A new access
   token, phone number ID or dedicated number needs a new test.

The notification rules do not change: a **direct assignment** notifies the
assigned technician; a **transfer** notifies only the receiving technician;
**Open Jobs** send nothing; on **acceptance** the technician can be sent the
job's own customer site location.

**What you will have at the end of section 1:** a new SIM or landline for the
dedicated EJE number, able to receive a verification SMS or call, and **not**
registered on any WhatsApp app.

---

## 2. WhatsApp Business Platform (Cloud API) setup

Meta's names change often. In late 2026 the screens may say **"WhatsApp
account"** or **"Messaging account"** where older guides say **"WhatsApp
Business Account (WABA)"**. They mean the same thing for this guide. Main
sources: [Meta: Get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started.md),
[Meta: Access tokens](https://developers.facebook.com/docs/whatsapp/access-tokens),
[Meta: Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint.md).

### 2.1 Business portfolio (Meta Business Manager)

1. Go to <https://business.facebook.com> and sign in with the owner's personal
   Facebook or Meta account. Meta requires a real person as the admin.
2. If EJE has no business portfolio yet, create one: **EJE Industrial
   Electronics**, with the registered business address and a business email.
3. Add a second admin (the IT person) so the account is never locked to one
   person: **Settings → Users → People → Add**.

**Business verification** (Settings → Security Centre / Business info →
Start verification). It needs company registration documents (CIPC), and a
utility bill or bank statement matching the business name and address.

- It is **not required to start**. An unverified portfolio may message up to
  **250 unique people per rolling 24 hours**, shared across all its numbers.
  Verifying is one way to step up to 2,000. Source: [Meta: Messaging
  limits](https://developers.facebook.com/docs/whatsapp/messaging-limits).
  EJE messages its own technicians, so 250 a day is ample.
- It **is** required to become a Tech Provider (option A without a partner),
  and it helps if the display name review raises questions. Recommended, but
  not blocking.

### 2.2 Developer app

1. Go to <https://developers.facebook.com>. Register as a developer with the
   same Meta account if you have not already.
2. **My Apps → Create App**. Name: `EJE Job Notifications`. Contact email: the
   IT person's work email.
3. Use case: **"Connect with customers through WhatsApp"**. On older screens,
   choose app type **Business** and then **add the WhatsApp product**.
4. Link it to the **EJE Industrial Electronics** business portfolio.
5. Meta creates a WhatsApp Business Account (WABA) and a **test number**. You
   can send a test message to your own phone from **WhatsApp → API Setup**.
   The temporary token shown there expires within hours. **Do not give it to
   the developer.**
6. Later, when everything works, switch the app to **Live** mode (top of the
   App Dashboard). Meta warns that *"some webhooks will not be sent if your app
   is in Dev mode."* A Live app needs a **Privacy Policy URL** in **App settings
   → Basic**. Ask the developer which URL to use (**verify at setup time**).

### 2.3 Add and verify the dedicated EJE number

Use the **new dedicated number** from section 1 — never the office number.

1. In **WhatsApp → API Setup → Add phone number**. (Also available in Business
   Manager → WhatsApp Manager → Phone numbers.)
2. Enter the **display name**: the name technicians see, e.g. `EJE Industrial
   Electronics`. It must match the business. Meta's naming rules are in its
   Display name guidelines Help Centre article. Meta reviews the name, and you
   can change it at most 10 times in 30 days.
   Source: [Meta: Display names](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names.md).
3. Choose a category (e.g. *Professional services*), then verify the number by
   **SMS or voice call** using the code Meta sends.
4. Meta requires a **two-step verification PIN** (6 digits) when the number is
   registered. **Store it in the password manager.** You need it to change or
   remove the number later, and it cannot be switched off through the API.
5. Adding a number in the dashboard does **not** by itself make it usable. It
   must also be **registered** for Cloud API. The dashboard usually offers this.
   If it does not, the developer does it once with the PIN.
6. Wait until the number's **Status** is *Connected* and the display name is
   *Approved* (WhatsApp Manager → Phone numbers). Meta does not publish a fixed
   review time.

### 2.4 Payment method

1. Business Manager → **Billing & payments** (Billing Hub) → add a card for the
   WhatsApp account.
2. **Choose the billing currency carefully.** It is fixed when the account is
   created and cannot simply be changed. Meta lists 16 currencies (**verify at
   setup time** whether ZAR is offered).

**Current pricing model** (checked 1 November 2026, [Meta: Pricing](https://developers.facebook.com/docs/whatsapp/pricing)):

- Since **1 July 2025** Meta charges **per delivered template message**, by
  category (marketing, utility, authentication) and the recipient's country.
  It no longer charges per 24-hour conversation.
- All three EJE messages are **utility** templates. **South Africa is its own
  market** on the rate card, and Meta raised the South African utility and
  authentication rates on **1 October 2026**. See the current ZA rate at
  [business.whatsapp.com/products/platform-pricing](https://business.whatsapp.com/products/platform-pricing#rates).
- Utility templates have **volume tiers**: cheaper per message at higher
  monthly volumes, counted across the whole business portfolio.
- From **1 October 2026**, utility templates sent *inside* an open 24-hour
  customer-service window are also charged (they used to be free). Plain
  replies in that window are free for the first **1,000 per number per
  month**. Without a payment method, service messages stop being delivered
  once that free allowance is used.

### 2.5 Permanent access token (System User)

Source: [Meta: Access tokens](https://developers.facebook.com/docs/whatsapp/access-tokens).

1. Business Manager → **Settings → Users → System users → Add**. Name:
   `eje-server`. Role: **Employee**. Employee gives the least access.
2. Click the system user → **Assign assets**:
   - **Apps** → `EJE Job Notifications` → **Manage app** (full control). Reload
     the page to confirm it shows **Full control**. It can take a few minutes.
   - **WhatsApp accounts** → EJE's WhatsApp account → full control (*Manage
     WhatsApp Business accounts*). If the screen also lists a **Messaging
     account**, assign that too. Meta says to assign both explicitly.
3. Click **Generate token** → choose the app → expiry **Never**, if offered.
   Meta calls system user tokens "long-lived", and the exact expiry options
   on screen should be **verified at setup time**.
4. Tick the permissions **`whatsapp_business_messaging`** and
   **`whatsapp_business_management`**. Meta's guide also lists
   `business_management`. EJE does not need it to send messages or read
   template status. Add it only if the screen will not generate the token
   without it.
5. Copy the token **straight into the password manager**. Meta shows it once.
   This is `WHATSAPP_ACCESS_TOKEN`.

### 2.6 The IDs and the App Secret

| What | Where to find it | Setting |
|---|---|---|
| The dedicated number itself | The new number from section 1, with the country code, e.g. `+27 82 …` | `WHATSAPP_DEDICATED_NUMBER` |
| The office number (to protect it) | The office's existing WhatsApp number. Optional, recommended | `WHATSAPP_PROTECTED_NUMBERS` |
| Phone Number ID | App Dashboard → WhatsApp → **API Setup**, under the **dedicated** "From" number. A long number, **not** the phone number itself | `WHATSAPP_PHONE_NUMBER_ID` |
| WhatsApp Business Account ID | Same page, "WhatsApp Business Account ID". Also in WhatsApp Manager → account settings | `WHATSAPP_BUSINESS_ACCOUNT_ID` |
| App Secret | App Dashboard → **App settings → Basic → App secret → Show** (asks for your password) | `WHATSAPP_APP_SECRET` |
| Webhook verify token | **You invent it.** On any Linux or Mac terminal: `openssl rand -hex 32` | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |

The App Secret lets EJE prove that an incoming webhook really came from Meta.
Meta signs every webhook with it in the `X-Hub-Signature-256` header, and
**EJE refuses all webhooks when `WHATSAPP_APP_SECRET` is not set.** Treat it
like a password.

### 2.7 Webhook (delivery reports and incoming messages)

Do this **after** the developer has put `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and
`WHATSAPP_APP_SECRET` into the server and restarted the service. Meta checks
the URL immediately.

1. App Dashboard → **WhatsApp → Configuration**. On the newer layout: **Use
   cases → Customize → Configuration**.
2. **Callback URL:** `https://eje.syncza.co.za/api/integrations/whatsapp/webhook`
3. **Verify token:** the same random string as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
4. Click **Verify and save**. Meta sends a check request, and EJE answers it
   only if the token matches. The site already has a valid public HTTPS
   certificate, which Meta requires.
5. Under **Webhook fields**, **subscribe to `messages`**. This field carries
   both incoming messages and the *sent / delivered / read / failed* status of
   EJE's messages.
6. Make sure the app is **subscribed to the WhatsApp account**. When the
   number was added through the app's own API Setup page this is normally
   done automatically. If no status updates ever arrive, the developer can
   check with `GET /<WABA-ID>/subscribed_apps` and subscribe with
   `POST /<WABA-ID>/subscribed_apps` (**verify at setup time**).
7. `eje.syncza.co.za` sits behind **Cloudflare**. If verification fails with a
   timeout or a 403, check that no Cloudflare firewall, bot-fight or "under
   attack" rule is blocking Meta's servers from that one path.

### 2.8 Message templates

Every first message EJE sends is outside the 24-hour window, so WhatsApp only
accepts **approved templates**. Create them in **WhatsApp Manager → Message
templates → Create template**.

For all three templates:

- **Category:** `Utility`. Do not choose Marketing. Meta may re-categorise a
  template it considers promotional.
- **Name:** exactly as below. Lowercase, with underscores.
- **Language:** **English** with code **`en`**. This must equal
  `WHATSAPP_TEMPLATE_LANGUAGE` (default `en`). If you pick *English (US)*
  (`en_US`) or *English (UK)* (`en_GB`) instead, tell the developer so the
  setting matches.
- **Variable type:** **Number** (positional `{{1}}`, `{{2}}` …), not "Name".
- **Samples:** Meta requires a sample value for every variable. Use the samples
  below, not real customers.
- **Header, footer, buttons:** none, unless agreed with the developer (see the
  URL note below).

**`eje_job_assigned`** — body:

```
EJE job {{1}} ({{2}}) has been assigned to you.
Customer: {{3}}
Site: {{4}}
Machine: {{5}}
Open the job in EJE: {{6}}
Reply to the office if you cannot attend.
```

**`eje_job_transferred`** — body:

```
EJE job {{1}} ({{2}}) has been transferred to you.
Customer: {{3}}
Site: {{4}}
Machine: {{5}}
Open the job in EJE: {{6}}
Reply to the office if you cannot attend.
```

Samples for both:

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | Job number | `EJE-2078` |
| `{{2}}` | Job type | `Breakdown` |
| `{{3}}` | Customer company | `Sample Engineering (Pty) Ltd` |
| `{{4}}` | Site name | `Main Plant` |
| `{{5}}` | Machine, or "Not specified" | `CNC Lathe 3` |
| `{{6}}` | Link to the job | `https://eje.syncza.co.za/jobs/EJE-2078` |

**`eje_site_location`** — body:

```
Site location for EJE job {{1}}
Customer: {{2}}
Machine: {{3}}
Site: {{4}}
Address: {{5}}
Navigate: {{6}}
Drive safely.
```

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | Job number | `EJE-2078` |
| `{{2}}` | Customer company | `Sample Engineering (Pty) Ltd` |
| `{{3}}` | Machine | `CNC Lathe 3` |
| `{{4}}` | Site name | `Main Plant` |
| `{{5}}` | Address | `1 Sample Street, Johannesburg` |
| `{{6}}` | Google Maps link | `https://www.google.com/maps/dir/?api=1&destination=-26.2041,28.0473` (when the pin is not verified, EJE sends an address-search link instead) |

**Two review risks to know about:**

1. **A body that ends with a variable.** The bodies above therefore end with a fixed line, not with `{{6}}`.
   Meta's own template reference does not state the rule, but several Meta
   partners report that a body which **starts or ends with a variable** is a
   common reason for rejection
   ([example](https://docs.bird.com/applications/content/message-templates/concepts/whatsapp-message-templates/whatsapp-business-template-guidelines-and-restrictions)).
   If Meta rejects a template for this reason, add a fixed closing line to
   the body, e.g. `Reply to the office if you cannot attend.` Fixed text adds
   no variable, so the application still sends the same six values. **Tell the
   developer about any wording change.** The variable count and order must
   stay exactly as above.
2. **A URL as a body variable.** Partner guides disagree on this. Some say
   full links in the body are fine, others say to use a button. Meta's
   official template page does not say. Never use a URL shortener. If Meta
   rejects the link variable, the alternative is a **"Visit website" URL
   button with a dynamic suffix**, e.g. base URL `https://eje.syncza.co.za/jobs/`
   plus one variable `EJE-2078`. That changes how the application must send
   the message, so it is a **developer change**. Do not do it without them.

Review is automatic and can take **up to 24 hours**
([Meta: Message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates)).
The template names come from the application, so a renamed template is simply
"not found".

**Recipients' consent.** Meta's policy expects people to have agreed to receive
WhatsApp messages from a business. Get each technician's agreement, e.g. in
their employment paperwork or a signed note, before they are messaged.

### 2.9 Messaging limits

- Limits are per **business portfolio**, counted as unique recipients in a
  rolling 24 hours: **250 → 2,000 → 10,000 → 100,000 → unlimited**. Verifying
  the business is one way to reach 2,000. After that the limit increases
  automatically with good-quality use.
  Source: [Meta: Messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits).
- Low-quality ratings (people blocking or reporting the number) can lower the
  limit. Only message staff who expect it.

**What you will have at the end of section 2:**

- [ ] `WHATSAPP_PHONE_NUMBER_ID`
- [ ] `WHATSAPP_BUSINESS_ACCOUNT_ID`
- [ ] `WHATSAPP_ACCESS_TOKEN` (permanent System User token, in the password manager)
- [ ] `WHATSAPP_APP_SECRET` (in the password manager)
- [ ] `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (the random string you made)
- [ ] The template language code (`en` unless you chose otherwise)
- [ ] `WHATSAPP_TEST_RECIPIENTS`: one or two **internal** mobile numbers in
      international format without `+` or spaces, e.g. `27821234567`
- [ ] The three templates showing **Active / Approved**
- [ ] A payment method on the WhatsApp account
- [ ] The two-step verification PIN, in the password manager (not for the
      developer)

---

## 3. Microsoft 365 email (sending from sales@ejeie.co.za)

EJE sends system emails **as `sales@ejeie.co.za`** using Microsoft Graph,
**without a person signing in** (an "app-only" registration). The application
calls `POST /users/sales@ejeie.co.za/sendMail` with `saveToSentItems=true`,
and needs exactly **one** permission: **`Mail.Send` (application)**.

**The office ladies keep using the mailbox exactly as they do now.** Nothing
changes in Outlook. Every email the system sends appears in the mailbox's
**Sent Items**, so the office can see what went out. Replies come back to the
mailbox, or to `EMAIL_REPLY_TO` if that is set.

Whoever does this needs a Microsoft 365 **Global Administrator**, or both
**Application Administrator** (for Entra) and **Exchange Administrator /
Organization Management** (for step 3.6).

### 3.1 Confirm what kind of mailbox sales@ is

1. Microsoft 365 admin centre (<https://admin.microsoft.com>) → **Users →
   Active users**: if `sales@ejeie.co.za` is listed there with a licence, it is
   a **licensed user mailbox**.
2. Otherwise → **Teams & groups → Shared mailboxes**: if it is listed there, it
   is a **shared mailbox**.
3. Either works. Microsoft's `sendMail` page documents
   `POST /users/{id | userPrincipalName}/sendMail` with the application
   permission `Mail.Send`
   ([Microsoft Graph: user sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)).
   A shared mailbox is addressed the same way. The sendMail page does not
   mention shared mailboxes explicitly, so **confirm with the test in 3.8**.
4. If `sales@` is only an **alias** or a **distribution list** (not a mailbox),
   stop and tell the developer. Graph cannot send from an alias this way.

### 3.2 Register the application in Entra

Source: [Microsoft: Register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

1. <https://entra.microsoft.com> → **Identity → Applications → App
   registrations → New registration**.
2. Name: `EJE Job Card Mailer`. Supported account types: **Accounts in this
   organizational directory only (single tenant)**. Redirect URI: leave empty.
3. Click **Register**. On the **Overview** page, copy:
   - **Directory (tenant) ID** → `EMAIL_GRAPH_TENANT_ID`
   - **Application (client) ID** → `EMAIL_GRAPH_CLIENT_ID`

These two are identifiers, not secrets.

### 3.3 Credential: a certificate (preferred)

Microsoft *"recommends that you use a certificate instead of a client secret"*
for production, and says client secrets *"should not be used in production
environments"* ([Microsoft: Add credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)).
Microsoft also says production should ideally use a CA-signed certificate. For
one server authenticating to its own tenant, a self-signed certificate is the
common practical choice. The owner may decide otherwise.

**On the VPS**, so the private key never leaves the server. The commands below
put the files in `/etc/eje/`, the directory that already holds the settings
file. Use the same directory unless the developer says otherwise.

```bash
# 1. Create a 2-year self-signed certificate and its private key.
sudo openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes \
  -subj "/CN=EJE Job Card Mailer" \
  -keyout /etc/eje/graph-mail.key -out /etc/eje/graph-mail.cer

# 2. Combine the private key and certificate into ONE PEM file for the app.
sudo sh -c 'cat /etc/eje/graph-mail.key /etc/eje/graph-mail.cer > /etc/eje/graph-mail.pem'

# 3. Only root and the eje service group may read it (same rule as eje.env).
sudo chown root:eje /etc/eje/graph-mail.pem
sudo chmod 0640 /etc/eje/graph-mail.pem
sudo rm /etc/eje/graph-mail.key          # the key now lives only inside graph-mail.pem

# 4. The SHA-1 thumbprint, as 40 hex characters without colons.
openssl x509 -in /etc/eje/graph-mail.cer -noout -fingerprint -sha1 | sed 's/.*=//; s/://g'
```

Then:

1. Copy **`/etc/eje/graph-mail.cer`** (the public part only, safe to copy) to
   your computer, e.g. with WinSCP or `scp`.
2. Entra → your app → **Certificates & secrets → Certificates → Upload
   certificate** → choose the `.cer` file (Entra accepts `.cer`, `.pem` and
   `.crt`) → **Add**.
3. Check that the **Thumbprint** Entra shows matches the 40 characters from
   step 4 (letters may differ in upper/lower case).
4. Put a **calendar reminder 1 month before the certificate expires** (730
   days from today). On renewal, repeat this section and give the developer
   the new thumbprint.

You now have:
- `EMAIL_GRAPH_CERTIFICATE_PATH=/etc/eje/graph-mail.pem`
- `EMAIL_GRAPH_CERTIFICATE_THUMBPRINT=<the 40 hex characters>`

**Alternative: a client secret** (simpler, less secure). **Certificates &
secrets → Client secrets → New client secret**. The longest allowed lifetime
is **24 months**, and Microsoft recommends **less than 12**. Copy the
**Value** (not the Secret ID) at once, because it is never shown again. That
is `EMAIL_GRAPH_CLIENT_SECRET`. Set a reminder before it expires. When it
expires, email stops.

Use **either** the certificate pair **or** the secret, not both.

### 3.4 Permission: Mail.Send, then restrict it to one mailbox

`Mail.Send` as an application permission normally allows sending **as any
mailbox in the company**. That must be narrowed to `sales@ejeie.co.za` only.

Microsoft's current guidance (checked 1 November 2026; [Microsoft: RBAC for
Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac),
updated 27 October 2026):

- **RBAC for Applications** is the current method, and it *"replaces
  Application Access Policies"*.
- Permissions from Entra and from Exchange RBAC **add together**: *"the
  assigned permissions are a union operation on the permissions from Microsoft
  Entra ID and the permissions assigned in Exchange Online RBAC."*
- Therefore: **if `Mail.Send` is granted (admin-consented) in Entra, the app
  can still send as anyone, whatever the Exchange scope says.** Microsoft says
  you must *"remove the organization-wide unscoped permissions assigned in
  Microsoft Entra ID"* for the scope to have any effect.

So the **recommended path** is:

1. **Do not grant `Mail.Send` in Entra.** Leave **API permissions** without
   `Mail.Send`.
2. Grant `Mail.Send` **only** through Exchange RBAC, scoped to the one mailbox
   (3.6).

If someone already added `Mail.Send` and clicked **Grant admin consent**:
Entra → app → **API permissions** → `Mail.Send` → **…** → **Revoke admin
consent**, then **Remove permission**. Check **Enterprise applications → EJE
Job Card Mailer → Permissions** to confirm nothing remains.

(The **legacy** alternative, if RBAC for Applications cannot be used: grant
`Mail.Send` in Entra with admin consent, then limit it with an [Application
Access Policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
(`New-ApplicationAccessPolicy -AccessRight RestrictAccess`). Microsoft is
replacing this method. Do not combine the two.)

The app-registration page may also list a default delegated **`User.Read`**
permission. It does nothing for an app-only sender and can be removed.

### 3.5 Find the two IDs Exchange needs

Microsoft warns: *"Don't use the IDs from the App Registrations page."* Use
**Entra → Enterprise applications → EJE Job Card Mailer → Overview**:

- **Application ID** (the same value as the client ID), and
- **Object ID**: the *enterprise application's* object ID. This is different
  from the object ID on the App registrations page.

### 3.6 Exchange Online: scope Mail.Send to sales@ only

On a Windows PC with PowerShell, as an Exchange admin (Organization
Management):

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once
Connect-ExchangeOnline -UserPrincipalName admin@ejeie.co.za   # an admin account

# 1. Tell Exchange about the app (IDs from 3.5).
New-ServicePrincipal -AppId <APPLICATION-ID> -ObjectId <ENTERPRISE-APP-OBJECT-ID> -DisplayName "EJE Job Card Mailer"

# 2. A scope that matches exactly one mailbox.
New-ManagementScope -Name "EJE mailer - sales mailbox only" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'sales@ejeie.co.za'"

# 3. Grant Mail.Send, limited to that scope.
New-ManagementRoleAssignment -Name "EJE mailer Mail.Send" `
  -Role "Application Mail.Send" `
  -App <ENTERPRISE-APP-OBJECT-ID> `
  -CustomResourceScope "EJE mailer - sales mailbox only"
```

### 3.7 Check the scope

```powershell
# Must show Application Mail.Send with InScope = True
Test-ServicePrincipalAuthorization -Identity <ENTERPRISE-APP-OBJECT-ID> -Resource sales@ejeie.co.za

# Must show InScope = False for any other mailbox
Test-ServicePrincipalAuthorization -Identity <ENTERPRISE-APP-OBJECT-ID> -Resource someone.else@ejeie.co.za
```

Microsoft notes that this test **does not include permissions granted in
Entra**, which is why 3.4 removes them. Changes can take **30 minutes to 2
hours** to apply to the live app (the test itself is immediate). If the
first real send fails with "access denied", wait two hours and try again
before changing anything.

**What you will have at the end of section 3:**

- [ ] `EMAIL_GRAPH_TENANT_ID`
- [ ] `EMAIL_GRAPH_CLIENT_ID`
- [ ] **Either** `EMAIL_GRAPH_CERTIFICATE_PATH` + `EMAIL_GRAPH_CERTIFICATE_THUMBPRINT`
      (the PEM already on the server, `0640 root:eje`) **or** `EMAIL_GRAPH_CLIENT_SECRET`
      (in the password manager), with its expiry date written down
- [ ] `EMAIL_SENDER=sales@ejeie.co.za`
- [ ] Optional `EMAIL_REPLY_TO`
- [ ] `EMAIL_TEST_RECIPIENTS`: one or two **internal** addresses, e.g.
      `owner@ejeie.co.za,it@ejeie.co.za`
- [ ] `Test-ServicePrincipalAuthorization` showing *InScope True* for sales@ and
      *False* for another mailbox
- [ ] **No** tenant-wide `Mail.Send` consent left in Entra

---

## 4. Google Maps Platform (Geocoding API)

**Why a key is needed only for some things:**
- Opening a Google Maps link for coordinates EJE **already has** (e.g. the
  "Navigate" link in WhatsApp) needs **no key and costs nothing**.
- Turning a **typed address into coordinates** uses the **Geocoding API**,
  which needs a key and a billing account.

### 4.1 Project and billing

1. <https://console.cloud.google.com> → sign in with an EJE Google account,
   not someone's private Gmail if avoidable.
2. Project picker → **New project** → `eje-geocoding`.
3. **Billing → Link a billing account** (create one with a company card).
   Google requires billing even when usage stays inside the free amount.

### 4.2 Turn on the Geocoding API

**APIs & Services → Library** → search **Geocoding API** → **Enable**. Enable
nothing else.

### 4.3 Pricing (checked 1 November 2026)

Source: [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing),
[March 2025 changes](https://developers.google.com/maps/billing-and-pricing/march-2025).

- On **1 March 2025** Google replaced the old $200 monthly credit with a
  **free monthly allowance per product (SKU)**.
- **Geocoding** is an *Essentials* SKU: the first **10,000 requests each month
  are free**, then **US$5.00 per 1,000** requests (up to 100,000 a month,
  cheaper above that). The free allowance resets on the 1st of each month
  (Pacific time).
- At EJE's built-in cap of 500 a day (below) the worst case is about 15,000 a
  month, roughly **US$25** over the free allowance. Normal use should be far
  less.

### 4.4 Create and restrict the API key

Source: [Google: Geocoding API key](https://developers.google.com/maps/documentation/geocoding/get-api-key),
[API security best practices](https://developers.google.com/maps/api-security-best-practices).

1. **Google Maps Platform → Keys & Credentials** (or **APIs & Services →
   Credentials**) → **Create credentials → API key**.
2. Rename it `eje-server-geocoding`.
3. **API restrictions → Restrict key → only "Geocoding API"**.
4. **Application restrictions → IP addresses** → add the VPS's **public**
   address(es).
5. Save. Restrictions can take a few minutes to apply.

**Finding the VPS public IP.** Do not look up `eje.syncza.co.za`: it points at
Cloudflare, not the server. Use any of:
- **Hostinger hPanel → VPS → Overview** shows the IPv4 (and IPv6 if enabled).
- On the server:
  ```bash
  curl -4 -s https://api.ipify.org; echo     # public IPv4
  curl -6 -s https://api64.ipify.org; echo   # public IPv6, if the server has one
  ```
  Add both. If the server has IPv6, Google may see requests arrive over IPv6,
  and a key restricted to IPv4 only would then refuse them.

This is a **server-side key**. It goes only in `/etc/eje/eje.env` as
`GOOGLE_MAPS_GEOCODING_API_KEY`, **never** in a variable starting with
`NEXT_PUBLIC_`, which would publish it to every browser.

### 4.5 Spending protection

Use both layers:

1. **Google quota cap:** **APIs & Services → Geocoding API → Quotas & system
   limits** → *Requests per day* → **Edit** → e.g. `600`. Google then refuses
   requests above that number. Screen names vary, so **verify at setup time**.
2. **EJE's own cap:** `GOOGLE_GEOCODING_DAILY_LIMIT` (default `500`). Set it
   slightly *below* Google's cap so EJE stops first and can explain why.
3. **Budget alert:** **Billing → Budgets & alerts → Create budget**, e.g.
   US$10 a month, with email alerts at 50%, 90% and 100%. A budget alert only
   **notifies**. It does not stop spending
   ([Google Cloud: Budgets](https://cloud.google.com/billing/docs/how-to/budgets)),
   which is why the quota cap matters.

`GOOGLE_GEOCODING_REGION` (default `za`) tells Google to prefer South African
results for ambiguous addresses.

### 4.6 Terms: how long EJE keeps coordinates (decided 1 November 2026)

**The owner's decision:** keep office-verified pins, recheck unverified
addresses, never replace an office-verified pin automatically with a new
geocoding result, and flag a pin for office review when its address changes —
**within what Google's terms allow**. The terms were read on 1 November 2026
and they do **not** allow everything that decision would like, so EJE
implements the closest compliant version, described below.

**What the official sources say** (quoted, read 1 November 2026):

| Source | What it says |
|---|---|
| [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) (last modified 28 October 2026), Geocoding API **6.3.1** | *"Customer may temporarily cache latitude (lat) and longitude (lng) values from the Geocoding API for up to 30 consecutive calendar days, after which Customer must delete the cached latitude and longitude values."* |
| Same, **6.3.2** | Indefinite caching of lat/lng, formatted address and structured address is allowed *"solely to support the direct, End User facing functionality of the Customer Application that initiated the request … only where the cache is not used as a replacement for making an additional call to the Services. Cached data must be logically isolated to the specific End User it is associated with and must not be used across multiple End Users."* |
| Same, **6.1 / 6.2** | Geocoding API content may be used without a map, but *"must not"* be used *"in conjunction with a non-Google map"*. |
| [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) (last modified 26 August 2026), **3.2.3(a)–(b)** | *"No Scraping … Customer will not … pre-fetch, index, store, reshare, or rehost Google Maps Content outside the services"* and *"No Caching. Customer will not cache Google Maps Content except as expressly permitted under the Maps Service Specific Terms."* |
| [Geocoding API policies](https://developers.google.com/maps/documentation/geocoding/policies) (updated 30 October 2026) | *"the place ID, used to uniquely identify a place, is exempt from the caching restrictions. You can therefore store place ID values indefinitely."* |
| [Place IDs guide](https://developers.google.com/maps/documentation/places/web-service/place-id) | Place IDs are exempt from the caching restriction in 3.2.3(b); Google recommends refreshing a stored place ID that is more than 12 months old. |
| [Google Maps End User Additional Terms](https://www.google.com/help/terms_maps/) (last modified 27 January 2026) | People using Google Maps may not *"copy the content"* unless permitted by Google's permissions page or by law. |

**What follows for EJE.**

1. A site pin is **shared by every office user and every technician** — it is
   not "logically isolated to the specific End User". So 6.3.2 does **not**
   apply, and coordinates that came from the Geocoding API fall under the
   **30-day limit of 6.3.1**, whether or not the office has verified them.
   Nothing in the terms says that a person checking a Google result turns it
   into the customer's own data, so EJE does **not** assume it does.
2. The **place ID** may be kept indefinitely.
3. Coordinates the **office itself** obtained — taken at the site with the
   phone's own GPS, given by the customer, or entered before Google was ever
   connected — are EJE's own business data and are not Google Maps Content.
   They may be kept. They must not be copied out of Google Maps (the End User
   terms above), so EJE no longer suggests doing that.
4. EJE uses Google results only with **Google Maps** links (6.2).

**The retention policy EJE implements** (code: rule 5 in
`src/domain/site/location.ts`, run by the worker every minute):

| What | Kept for | What happens then |
|---|---|---|
| The customer's/site's own address | Always | Never replaced by Google's wording |
| Coordinates the office entered (by hand, or "Use this device's location" at the site) | Always | Never replaced by a geocoding result. An address change marks the pin **Re-check the pin**; a new Google match waits beside it as a suggestion |
| Pins existing before automatic pins (migration 0042 marked them office-entered) | Always | As above |
| Google coordinates on an **office-verified** pin | At most 30 days from when Google returned them | From day 27 EJE asks Google again **for the same place ID**. If Google still puts the place within 30 m, the fresh coordinates are kept and the pin **stays verified**. If it moved, the pin becomes **Re-check the pin** with the new point only as a suggestion. If Google could not be asked, the coordinates are **deleted on day 30**; the verification record and the place ID stay, and technicians are navigated to the verified **place** |
| Google coordinates on an **unverified** pin (found automatically, or an unsure match) | At most 30 days | From day 27 the address is looked up again and the new answer is used; if that cannot happen, the coordinates are deleted on day 30 and the site goes back to "find the pin from the address" |
| Google suggestions | At most 30 days | Deleted on day 30 |
| The geocoding cache | Answers used for 27 days, deleted at 30 | Deleted rows are gone from the database |
| Google's formatted address and precision | **Not stored** | — |
| The place ID | Indefinitely (exempt) | Used for navigation links and for the refresh |
| Who verified a pin, when, and its source (office or Google) | Always | Shown on the customer's location card, with the date Google's coordinates will be refreshed or deleted |

Two further consequences, both deliberate:

- **Links never contain Google's coordinates.** A technician's navigation link
  for a Google pin names the **place ID** (`destination_place_id`), so a
  WhatsApp message or job record that is kept for years does not keep Google's
  coordinates. An office-entered pin is linked by its coordinates.
- **The audit trail never records Google's coordinates.** It is permanent, so
  it says "pin from the geocoder (its coordinates are not kept in the log)".
  Office-entered coordinates are recorded as before.

**What this costs.** One extra Geocoding request per Google-derived pin every
27 days (about 13 a year per site), within the free monthly allowance for a
customer list of EJE's size, and capped by `GOOGLE_GEOCODING_DAILY_LIMIT`.

**What would allow permanent retention of Google coordinates.** Only Google
can grant it (a written agreement, or a change in the terms). The alternatives
that need no permission are already built in: keep the place ID (permanent),
or have the office record its own coordinates at the site.

**What you will have at the end of section 4:**

- [ ] `GOOGLE_MAPS_GEOCODING_API_KEY` (restricted to Geocoding API + the VPS IP(s))
- [ ] `GOOGLE_GEOCODING_REGION` (`za`, unless you want otherwise)
- [ ] `GOOGLE_GEOCODING_DAILY_LIMIT` (e.g. `500`)
- [ ] A Google daily quota cap and a budget alert in place
- [ ] Staff told: coordinates typed into EJE come from the site (this device's location) or the customer — not copied out of Google Maps (4.6)

---

## 5. After you have the details

### 5.1 Hand them over safely

**Never** send a token, secret, App Secret or private key by email, WhatsApp,
SMS, Teams chat or a shared document. Use one of these:

1. **Best:** the IT person (or the owner, with the developer watching on a
   call) types them directly into the server file:
   ```bash
   sudo nano /etc/eje/eje.env
   ```
   Keep the file's permissions as they are (`0640`, owner `root`, group `eje`).
   Then restart:
   ```bash
   sudo systemctl restart eje
   ```
2. **Or:** a **password-manager share** (e.g. Bitwarden Send or 1Password item
   sharing) with expiry, sent only to the developer.

The IDs (tenant ID, client ID, Phone Number ID, WABA ID, thumbprint) are not
secrets, but it is simplest to hand everything over the same way.

Lines in `/etc/eje/eje.env` look like `NAME=value`, with no spaces around `=`.
The private-key PEM file stays on the server. Only its **path** goes into the
settings file.

### 5.2 Check the status in EJE

Sign in as an administrator → **Administration → Integrations**. Each
integration shows one of:

| Status | Meaning | What to do |
|---|---|---|
| **Not configured** | None of its settings are present — or, for WhatsApp, all are present but no real test has passed yet with them | Add the settings, restart; for WhatsApp then send the test (5.4) |
| **Configuration incomplete** | Some settings are present, some are missing or malformed | The screen names the missing setting. Add it, restart |
| **Connected** | The provider accepted the credentials | Run the test plan (5.4) |
| **Authentication failed** | The provider refused the credentials | Wrong or expired token, secret, certificate or thumbprint, or a missing permission. Redo the relevant step |
| **Service unavailable** | The provider could not be reached right now | Wait and re-check. **Do not** rotate credentials for this |
| **Action required** | Credentials work, but something on the provider's side is missing, e.g. a WhatsApp template not yet approved, or webhooks not verified | Follow the message on screen |

### 5.3 The command-line check

On the server, the developer or IT person can run the built-in check. It loads
the settings file the safe way described in `docs/vps-deployment.md` (the
shell's own loader, not `xargs`):

```bash
cd /srv/eje/app
sudo -u eje bash -c 'set -a; . /etc/eje/eje.env; set +a; npm run integrations:check'
sudo -u eje bash -c 'set -a; . /etc/eje/eje.env; set +a; npm run integrations:check -- --probe'
```

- **Without `--probe`:** checks the configuration only. No network, nothing
  sent. Missing settings are named, and values are never printed.
- **With `--probe`:** contacts the providers but **sends nothing**. It gets a
  Microsoft token and nothing more — with `Mail.Send` alone the app cannot
  read any mailbox, so a token proves the credential and only the
  Administration test email proves the permission. It reads the WhatsApp
  number's own details from Meta and, when `WHATSAPP_BUSINESS_ACCOUNT_ID` is
  set, whether the templates this build sends are approved. No customer record
  is touched.
- Verdicts: `ABSENT` (not configured), `PENDING` (configured but not proven, or
  the provider was unreachable), `READY`, `REFUSED` (the provider rejected the
  credentials, or a template is missing). See `docs/integrations.md`.

### 5.4 Test plan (internal recipients only)

**No customer, and no technician who has not agreed, receives a test message.**
The Administration "send test" buttons will only send to addresses or numbers
listed in `EMAIL_TEST_RECIPIENTS` / `WHATSAPP_TEST_RECIPIENTS`.

**Email**
1. Administration → Integrations shows Email **Connected**.
2. Press **Send test email** to an address in `EMAIL_TEST_RECIPIENTS`.
3. The email arrives, and the sender shows as `sales@ejeie.co.za`.
4. In Outlook, the office sees the test email in **sales@ → Sent Items**.
5. Optional: reply to it and confirm the reply lands in the right mailbox.
6. Scope check: `Test-ServicePrincipalAuthorization` (3.7) still shows *False*
   for a mailbox other than sales@.
7. `journalctl -u eje -n 50` contains no secret, token or key.

**WhatsApp (the dedicated EJE number)**
1. Administration → Integrations shows *WhatsApp — dedicated EJE number* as
   **Not configured** with "the dedicated number and the Meta credentials are
   set, but no real test has passed", the dedicated number's last four digits,
   and the office number as *Not connected and never used*. All three
   templates approved, webhook verified.
2. Press **Send test** to a number in `WHATSAPP_TEST_RECIPIENTS`. That phone
   receives the message **from the dedicated number** with the right display
   name, and the status changes to **Connected**. Only now are job
   notifications sent.
3. Within a minute or two the test shows **delivered** (and **read** once
   opened). This proves the webhook works.
4. On a job assigned to an **internal test technician** whose phone is in the
   test list, assign and then transfer the job. Confirm `eje_job_assigned` and
   `eje_job_transferred` arrive and the job link opens the job.
5. Request the site location. Confirm `eje_site_location` arrives and
   **Navigate** opens Google Maps at the right place.
6. Confirm the office's WhatsApp Business app on the **office** number still
   sends and receives normally, with its chats and linked devices — EJE never
   touched it.

**Google Geocoding**
1. Administration → Integrations shows Google **Connected**.
2. On a **test** site, look up a known address (e.g. EJE's own premises).
   Coordinates are returned and the map link opens at the right spot.
3. The pin is shown as **unverified** until the office confirms it, with the
   date by which Google's coordinates will be refreshed or deleted (4.6).
4. Confirm the pin on the test site. The technician's navigation link names
   the Google **place**, not the coordinates.
5. In Google Cloud → **APIs & Services → Geocoding API → Metrics**, the
   request appears.
6. Optional: run one request from a computer that is **not** the VPS with the
   same key. Google must refuse it, which proves the IP restriction works.

---

## 6. Summary of every setting

All of these go in **`/etc/eje/eje.env`** on the VPS, followed by
`sudo systemctl restart eje`. Values shown are **placeholders**.

| Setting | Required? | Example placeholder | Where it comes from |
|---|---|---|---|
| `EMAIL_GRAPH_TENANT_ID` | Yes, for email | `00000000-0000-0000-0000-000000000000` | Entra → App registration → Overview → Directory (tenant) ID (3.2) |
| `EMAIL_GRAPH_CLIENT_ID` | Yes, for email | `11111111-1111-1111-1111-111111111111` | Entra → App registration → Overview → Application (client) ID (3.2) |
| `EMAIL_GRAPH_CERTIFICATE_PATH` | Preferred credential (with thumbprint) | `/etc/eje/graph-mail.pem` | The PEM file created on the VPS (3.3) |
| `EMAIL_GRAPH_CERTIFICATE_THUMBPRINT` | With the certificate path | `A1B2C3…` (40 hex characters) | `openssl … -fingerprint -sha1`, matching Entra's Thumbprint (3.3) |
| `EMAIL_GRAPH_CLIENT_SECRET` | Only if no certificate | `<secret value>` | Entra → Certificates & secrets → Client secrets → Value (3.3) |
| `EMAIL_SENDER` | Yes, for email | `sales@ejeie.co.za` | The sending mailbox (3.1) |
| `EMAIL_REPLY_TO` | No | `sales@ejeie.co.za` | Owner's choice |
| `EMAIL_TEST_RECIPIENTS` | For the test button | `owner@ejeie.co.za,it@ejeie.co.za` | Owner's choice, internal addresses only |
| `WHATSAPP_DEDICATED_NUMBER` | Yes, to send | `+27820000000` | The new dedicated EJE number (1.1, 2.6) |
| `WHATSAPP_PROTECTED_NUMBERS` | No, recommended | `+27110000000` | The office's existing WhatsApp number(s), comma-separated: EJE refuses to send from them (1.6) |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes, to send | `123456789012345` | App Dashboard → WhatsApp → API Setup, the dedicated number (2.6) |
| `WHATSAPP_ACCESS_TOKEN` | Yes, to send | `<system user token>` | Business Manager → System users → Generate token (2.5) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | To check template approval | `234567890123456` | App Dashboard → WhatsApp → API Setup (2.6) |
| `WHATSAPP_APP_SECRET` | Yes, for webhooks (refused without it) | `<app secret>` | App Dashboard → App settings → Basic (2.6) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Yes, for webhooks | `<output of openssl rand -hex 32>` | You invent it, and enter the same value in Meta (2.7) |
| `WHATSAPP_TEMPLATE_LANGUAGE` | No (default `en`) | `en` | The language the templates were approved in (2.8) |
| `WHATSAPP_TEST_RECIPIENTS` | For the test button | `27821234567,27831234567` | Owner's choice, internal mobiles only |
| `WHATSAPP_API_VERSION` | No (default `v21.0`) | `v21.0` | Developer's choice |
| `GOOGLE_MAPS_GEOCODING_API_KEY` | Yes, for address lookup | `<restricted API key>` | Google Cloud → Credentials (4.4). **Never** `NEXT_PUBLIC_` |
| `GOOGLE_GEOCODING_REGION` | No (default `za`) | `za` | Leave as `za` |
| `GOOGLE_GEOCODING_DAILY_LIMIT` | No (default `500`) | `500` | Owner's choice, slightly below Google's daily quota (4.5) |

Fixed values, not settings:

| What | Value |
|---|---|
| WhatsApp webhook callback URL | `https://eje.syncza.co.za/api/integrations/whatsapp/webhook` |
| WhatsApp template names | `eje_job_assigned`, `eje_job_transferred`, `eje_site_location` |
| Microsoft Graph permission | `Mail.Send` (application) only, scoped to `sales@ejeie.co.za` via Exchange RBAC |
| Google API enabled | Geocoding API only |

---

## 7. Things to verify at setup time

These could not be confirmed from official documentation on 1 November 2026:

1. ~~Whether WhatsApp coexistence accepts +27 numbers~~ — no longer needed:
   the owner chose a dedicated number (1.1).
2. ~~A partner's minimum age for coexistence~~ — no longer needed (1.1).
3. The exact **expiry options** shown when generating a System User token.
4. Whether Meta **accepts a URL as a body variable**, and a body that **ends
   with a variable**, in these utility templates.
5. Whether **ZAR** is offered as a WhatsApp billing currency, and the current
   South African utility rate.
6. That `sendMail` works from `sales@` if it is a **shared** mailbox. Confirmed
   by the email test in 5.4.
7. The exact Google Cloud screen for the **daily request quota**, and whether
   the VPS sends Google requests over **IPv6**.
8. ~~How Google's caching terms apply to office-verified coordinates~~ —
   answered from the terms in 4.6: Google's coordinates are kept for at most
   30 days whether or not verified; the place ID and the office's own
   coordinates are kept.
