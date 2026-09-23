# VPS smoke test

Run after deploying. Every step is an API call or a workflow, not a page load —
a screen that renders is not a screen that works.

`-c/-b jar` keeps the session cookie, which is the only thing carrying identity.

```bash
HOST=https://eje.syncza.co.za
```

## 1. The deployment itself

Infrastructure before anything else — a failing workflow means nothing until
this section passes.

```bash
curl -s $HOST/api/health
curl -sI http://eje.syncza.co.za | head -1
```

The first goes through Cloudflare, through Caddy, into the Node process, out to
PostgreSQL and back. Want
`{"status":"ok","backend":"postgres","database":"reachable",...}`, and a `308`
to HTTPS from the second.

`"demoSwitcher"` says whether this deployment offers one-click sign-in as the
published demonstration accounts. On `eje.syncza.co.za` that is `true` and
intended; **on the live EJE deployment it must be `false`**, and if it is not,
remove `EJE_DEMO_SWITCHER` from `/etc/eje/eje.env` and restart before doing
anything else.

`"backend":"demo"` means `DATABASE_URL` did not reach the process — check
`/etc/eje/eje.env` and `systemctl show eje -p EnvironmentFile`.
`503` with `"database":"unreachable"` means the app is up and PostgreSQL is not:
`journalctl -u eje -n 50`.

Then the two things a health check cannot tell you, from a shell **on the VPS**:

```bash
sudo ss -lntp | grep 3000        # want 127.0.0.1:3000 — NOT 0.0.0.0:3000
sudo ss -lntp | grep 5432        # want 127.0.0.1:5432
```

`0.0.0.0:3000` means the Node port is published to the internet and Caddy is
decorative. From your own machine, a connection test to 3000 and to 5432 must
both **fail** while 443 succeeds; that is the check, not the `ss` output alone.

## 2. Authentication, for real

```bash
curl -s -c /tmp/m.jar -X POST -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"email":"master@eje-demo.local","password":"EjeDemo#2026"}' $HOST/api/auth/login
curl -s -b /tmp/m.jar $HOST/api/auth/me
```

Want the user and `"backend":"postgres"`. Then prove the negatives:

```bash
curl -s -X POST -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"email":"master@eje-demo.local","password":"wrong"}' $HOST/api/auth/login
curl -s $HOST/api/auth/me
```

Want `401` for both, with the same sentence for a wrong password as for an
unknown address.

**On a production database these accounts do not exist** — the seed is refused
there. Use a real account and expect the same shapes.

## 3. The office

```bash
curl -s -b /tmp/m.jar $HOST/api/dashboard   | head -c 200
curl -s -b /tmp/m.jar $HOST/api/jobs        | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('rows',len(d['rows']),'closedCount',d['closedCount']); print('statuses',sorted({r['job']['status'] for r in d['rows']}))"
curl -s -b /tmp/m.jar $HOST/api/jobs/closed | head -c 200
curl -s -b /tmp/m.jar $HOST/api/customers   | head -c 200
curl -s -b /tmp/m.jar $HOST/api/machines    | head -c 200
curl -s -b /tmp/m.jar $HOST/api/calendar    | head -c 200
curl -s -b /tmp/m.jar $HOST/api/library     | head -c 200
curl -s -b /tmp/m.jar $HOST/api/notifications | head -c 200
curl -s -b /tmp/m.jar $HOST/api/conversations | head -c 200
```

The Jobs line must show **no `closed` and no `cancelled`** among the statuses —
that is the operational filter — and `closedCount` must be a number.

## 4. Coordinator

```bash
curl -s -c /tmp/c.jar -X POST -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"email":"coordinator@eje-demo.local","password":"EjeDemo#2026"}' $HOST/api/auth/login
curl -s -b /tmp/c.jar $HOST/api/jobs/closed -o /dev/null -w 'closed archive: %{http_code}\n'
curl -s -b /tmp/c.jar $HOST/api/machines    -o /dev/null -w 'machine register: %{http_code}\n'
```

Want `200` and `200`.

## 5. Technician — the boundaries that matter

```bash
curl -s -c /tmp/t.jar -X POST -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"email":"technician1@eje-demo.local","password":"EjeDemo#2026"}' $HOST/api/auth/login

curl -s -b /tmp/t.jar $HOST/api/jobs/closed -o /dev/null -w 'closed archive (want 403): %{http_code}\n'
curl -s -b /tmp/t.jar $HOST/api/machines    -o /dev/null -w 'machine register (want 403): %{http_code}\n'
curl -s -b /tmp/t.jar $HOST/api/admin       -o /dev/null -w 'administration (want 403): %{http_code}\n'
curl -s -b /tmp/t.jar $HOST/api/customers   -o /dev/null -w 'customer register (want 200): %{http_code}\n'
```

Those four are the authorization model: the archive and the machine register are
office screens, the customer register is not.

### The historical path

This is how a technician reaches finished work now that the operational list is
current work only. Take a customer id from `/api/customers`, then:

```bash
curl -s -b /tmp/t.jar $HOST/api/customers/<CUSTOMER_ID> \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('machines',[m['id'] for m in d['machines']]); print('closed jobs',[r['job']['jobNumber'] for r in d['jobRows'] if r['job']['status']=='closed'])"

curl -s -b /tmp/t.jar $HOST/api/machines/<MACHINE_ID> \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; rows=d['jobRows']; print('history',[r['job']['jobNumber'] for r in rows]); print('any price field:', any(k in json.dumps(rows) for k in ['pricingSnapshot','unitPrice']))"

curl -s -b /tmp/t.jar $HOST/api/jobs/<CLOSED_JOB_NUMBER> -o /dev/null -w 'historical job (want 200): %{http_code}\n'
```

Want machine detail `200`, closed jobs listed in its history, **`any price
field: False`**, and the historical job opening.

### Price suppression on the detail view

```bash
curl -s -b /tmp/t.jar $HOST/api/jobs/<SOMEBODY_ELSES_CLOSED_JOB> \
  | python3 -c "import sys,json; j=json.load(sys.stdin)['data']['view']['job']; print('snapshot',j['pricingSnapshot']); print('part prices',[p['unitPrice'] for p in j['parts']])"
```

Want `snapshot None` and every part price `0` — reached through machine history,
so the money is removed. The same technician's **own** closed job keeps its
prices; that is the rule, and it is visibility-based, not role-based.

## 6. Machine workflow — unchanged by this phase

- A technician adds a machine found on site through **Customer → Machines →
  Add machine**; it lands `pending_approval`.
- A Master approves it; it becomes `approved`.
- A technician editing an official record is refused with *"Only a Master can
  change the official machine record"* — they raise a change request instead.

Exercise all three in the browser and confirm the audit trail records the
approval.

## 7. Workflows, in the browser

Log in as each role and carry one job through:

| | |
|---|---|
| Job | raise → accept → capture → checklist → complete |
| Signature | customer signature, and a refusal with its reason |
| Documents | the job card PDF renders and downloads |
| Parts | a parts collection processed at the counter |
| Transfers | a job handed to another technician |
| Awaiting spares | a job parked and resumed |
| Calendar | day, week, month, year; a multi-day Service bar; availability |
| Chat / Notifications | a message and the unread badge |
| Library | a document opens |
| Audit | the trail shows the above, attributed |

## 8. Integrations tell the truth

With WhatsApp unconfigured, an assignment must leave the outbox row `pending`
with the reason on it — never `sent`. Check the outbox screen, and:

```bash
curl -s -b /tmp/m.jar $HOST/api/outbox | head -c 300
```

A `sent` row with no configured credentials would be a fake success and a bug.

## 9. Restart and reboot

```bash
sudo systemctl restart eje
curl -s $HOST/api/health
sudo reboot
# after it comes back
curl -s $HOST/api/health
```

Both must return `"database":"reachable"` with no manual step — no SSH tunnel,
no `npm run start` by hand.
