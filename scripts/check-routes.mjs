/**
 * Route check against the RUNNING application.
 *
 * `npm run verify` proves the route files exist and that every link in the
 * source resolves. It cannot prove that the server answering on a port is
 * serving that code — which is exactly the failure a live demonstration hit,
 * where `/jobs/<n>/sign` and `/jobs/<n>/review` returned 404 from a stale
 * process while both routes were present and correct.
 *
 * So this asks the server. For every route in the matrix it checks the status
 * code AND that the body is not Next's default 404, because a 404 page is
 * served with a 404 status but a client-side route miss can render it inside a
 * 200. It also reports the build stamp the server is serving.
 *
 * Usage:
 *   npm run start            # or npm run dev
 *   npm run check-routes
 *   EJE_CHECK_URL=http://localhost:3000 npm run check-routes
 */
const BASE = process.env.EJE_CHECK_URL ?? 'http://localhost:3000';

/**
 * The canonical routes, with the concrete URL used to exercise each one.
 * `role` and `status` record what the route is FOR; the check itself only
 * proves the route is served, since authorisation is asserted by the unit and
 * smoke suites.
 */
const MATRIX = [
  { url: '/dashboard', role: 'Master / Technician', status: 'any', purpose: 'Dashboard' },
  { url: '/jobs', role: 'Master / Technician', status: 'any', purpose: 'Job list' },
  { url: '/jobs?status=open', role: 'Master / Technician', status: 'open', purpose: 'Open Jobs (a filter, not a route)' },
  { url: '/jobs/new', role: 'Master', status: 'n/a', purpose: 'Raise a job' },
  { url: '/jobs/closed', role: 'Master', status: 'closed', purpose: 'Closed-job archive' },
  { url: '/jobs/EJE-1048', role: 'assigned user', status: 'open', purpose: 'Job detail' },
  { url: '/jobs/EJE-1065/sign', role: 'Technician', status: 'customer_signature', purpose: 'Customer signature' },
  { url: '/jobs/EJE-1053/sign', role: 'Technician', status: 'completion', purpose: 'Customer signature, checklist gate' },
  { url: '/jobs/EJE-1055/review', role: 'Master', status: 'submitted', purpose: 'Master Review' },
  { url: '/jobs/EJE-1056/review', role: 'Master', status: 'closed', purpose: 'Final job card, read-only' },
  { url: '/jobs/EJE-1044/review', role: 'Master', status: 'closed', purpose: 'View Final PDF' },
  { url: '/messages', role: 'Master / Technician', status: 'any', purpose: 'Two-way chat' },
  { url: '/notifications', role: 'Master / Technician', status: 'any', purpose: 'Notification centre' },
  { url: '/notifications?tab=outbox', role: 'Master / Technician', status: 'any', purpose: 'Simulated Outbox' },
  { url: '/customers', role: 'Master', status: 'any', purpose: 'Customers' },
  { url: '/customers/cust-abc', role: 'Master', status: 'any', purpose: 'Customer history' },
  { url: '/machines', role: 'Master', status: 'any', purpose: 'Machine register' },
  { url: '/machines/machine-abc-lv40', role: 'Master', status: 'any', purpose: 'Machine history' },
  { url: '/technicians/user-tech-lerato', role: 'Master / self', status: 'any', purpose: 'Technician record' },
  { url: '/calendar', role: 'Master / Technician', status: 'any', purpose: 'Calendar' },
  { url: '/activity', role: 'Master', status: 'any', purpose: 'Audit trail' },
  { url: '/library', role: 'Master / Technician', status: 'any', purpose: 'Technical Library' },
  { url: '/search?q=LW-V40-70214', role: 'Master / Technician', status: 'any', purpose: 'Global search' },
  { url: '/admin', role: 'Master', status: 'any', purpose: 'Administration' },
  { url: '/schedule', role: 'any', status: 'any', purpose: 'Superseded — redirects to Calendar' },
];

/** A path that must NOT be served, so a pass here means something. */
const MUST_404 = ['/jobs/EJE-1048/master-review', '/jobs/EJE-1048/customer-signature', '/nonsense'];

const NEXT_404 = 'This page could not be found';

const probe = async (url) => {
  const response = await fetch(`${BASE}${url}`, { redirect: 'follow' });
  const body = await response.text();
  return { status: response.status, is404: body.includes(NEXT_404), finalUrl: response.url };
};

let failures = 0;
const pad = (value, width) => String(value).padEnd(width);

console.log(`Checking routes against ${BASE}\n`);
console.log(`${pad('ROUTE', 40)}${pad('ROLE', 22)}${pad('STATUS', 20)}RESULT`);
console.log('-'.repeat(96));

for (const entry of MATRIX) {
  let result;
  try {
    const { status, is404 } = await probe(entry.url);
    if (status >= 400) result = `FAIL  HTTP ${status}`;
    else if (is404) result = 'FAIL  served the 404 page';
    else result = `ok    ${status}`;
  } catch (error) {
    result = `FAIL  ${error.message}`;
  }
  if (result.startsWith('FAIL')) failures += 1;
  console.log(`${pad(entry.url, 40)}${pad(entry.role, 22)}${pad(entry.status, 20)}${result}`);
}

console.log('\nPaths that must NOT resolve:');
for (const url of MUST_404) {
  try {
    const { status, is404 } = await probe(url);
    const refused = status === 404 || is404;
    console.log(`${pad(url, 40)}${refused ? 'ok    refused' : `FAIL  served HTTP ${status}`}`);
    if (!refused) failures += 1;
  } catch (error) {
    console.log(`${pad(url, 40)}FAIL  ${error.message}`);
    failures += 1;
  }
}

// The build stamp the server is serving, read from the meta tag the root
// layout renders, so a stale process is obvious rather than inferred.
try {
  const body = await (await fetch(`${BASE}/dashboard`)).text();
  const read = (name) => {
    const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(body);
    return match === null ? null : match[1];
  };
  const commit = read('eje-build-commit');
  const built = read('eje-build-time');

  if (commit === null) {
    console.log('\nServer build stamp: NOT PRESENT — this server predates the build stamp,');
    console.log('  which means it is serving an older commit than the one checked out here.');
    failures += 1;
  } else {
    console.log(`\nServer build stamp: ${commit}  (built ${built ?? 'unknown'})`);
    const local = process.env.EJE_EXPECT_COMMIT;
    if (typeof local === 'string' && local.length > 0 && !local.startsWith(commit)) {
      console.log(`  MISMATCH: this checkout is ${local}. The server is serving a different build.`);
      failures += 1;
    }
  }
} catch {
  console.log('\nServer build stamp: could not be read');
}

console.log('\n=== ROUTE CHECK ===');
if (failures === 0) {
  console.log(`ALL ${MATRIX.length + MUST_404.length} ROUTE CHECKS PASSED`);
} else {
  console.log(`${failures} route check(s) FAILED`);
  console.log('If a route above failed, the server is almost certainly stale. Run: npm run redeploy');
  process.exitCode = 1;
}
