/**
 * SUBMITTING A PERSON'S FORMS THE WAY THE PRODUCT DOES (FORM-LIFECYCLE-1, the
 * owner, 6 November 2026) — for the browser suites that need a submission to
 * exist and are not themselves about the screens that make it
 * (`payroll-lifecycle-check.mjs` is).
 *
 * Each form the person keeps is COMPLETED for From–To (unless one already
 * waits for exactly those dates), then both are submitted together — Submit
 * to Office. `call(method, path, body)` is the suite's own signed-in request,
 * answering `{ status, json }`. The first refusal on the way is returned as it
 * came, so a suite can assert on it.
 */
export const completeAndSubmit = async (call, userId, from, to, { confirmUnrecorded = true, confirmNoLines = true, names = {} } = {}) => {
  const state = await call('GET', `/api/payroll/forms/${userId}/completed`);
  if (state.status !== 200) return state;
  const kinds = state.json.data.timesheetRequired ? ['timesheet', 'attendance'] : ['attendance'];
  for (const kind of kinds) {
    const waiting = state.json.data[kind];
    if (waiting !== null && waiting.from === from && waiting.to === to) continue;
    const done = await call('POST', `/api/payroll/forms/${userId}/complete`, { kind, from, to, fileName: names[kind] ?? '', confirmUnrecorded, confirmNoLines });
    if (done.status !== 200) return done;
  }
  return call('POST', `/api/payroll/forms/${userId}/submit`, {});
};

/** The refusal code of an answer, or null. */
export const refusalCode = (answer) => answer?.json?.error?.violations?.[0]?.code ?? null;
