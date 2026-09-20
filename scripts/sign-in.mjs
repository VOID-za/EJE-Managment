/**
 * Signing a browser in, for the scripted suites.
 *
 * THE IDENTITY PICKER IS GONE. It was a list of people the browser chose from,
 * which meant the client decided who it was; there is now an email address and
 * a password, verified on the server, and a session cookie the browser cannot
 * read. Every script signs in the way a technician does.
 *
 * The password is the demonstration one, which the sign-in screen itself
 * states. These scripts drive the DEMONSTRATION build — a real deployment has
 * real credentials, which are not in a repository.
 */
export const DEMO_PASSWORD = process.env.EJE_DEMO_PASSWORD ?? 'eje-demo';

/** The seeded people the suites use, by the name they are called on screen. */
export const PEOPLE = {
  'Elmarie Coetzee': 'elmarie.coetzee@eje-demo.co.za',
  'Johan Erasmus': 'johan.erasmus@eje-demo.co.za',
  'Denise Pillay': 'denise.pillay@eje-demo.co.za',
  'Christene van Niekerk': 'christene.vanniekerk@eje-demo.co.za',
  'Sipho Mahlangu': 'sipho.mahlangu@eje-demo.co.za',
  'Riaan van Wyk': 'riaan.vanwyk@eje-demo.co.za',
  'Thabo Nkosi': 'thabo.nkosi@eje-demo.co.za',
  'Francois du Toit': 'francois.dutoit@eje-demo.co.za',
  'Naledi Molefe': 'naledi.molefe@eje-demo.co.za',
  'Deon Botha': 'deon.botha@eje-demo.co.za',
  'Lerato Dlamini': 'lerato.dlamini@eje-demo.co.za',
  'André Steyn': 'andre.steyn@eje-demo.co.za',
};

/** Whether the sign-in form is on screen. */
export const atSignIn = async (page) =>
  (await page.getByRole('heading', { name: 'Sign in' }).count()) > 0;

/**
 * Signs the current session out, if there is one.
 *
 * Through the profile menu, which is where a person does it — and which is also
 * what revokes the session server-side rather than merely forgetting it here.
 */
export const signOut = async (page, timeout = 20000) => {
  const trigger = page.locator('header [aria-haspopup="menu"]');
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout });
};

/**
 * Signs in as one of the seeded people.
 *
 * `who` is either a name from `PEOPLE` or an email address. Nothing here picks
 * a role: the role comes back from the server with the session, which is the
 * whole point of the change.
 */
export const signInAs = async (page, who, options = {}) => {
  const { base, greeting, timeout = 20000, password = DEMO_PASSWORD } = options;
  const email = PEOPLE[who] ?? who;

  if (base !== undefined) {
    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  }
  if (!(await atSignIn(page))) await signOut(page, timeout);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout });

  // The button is disabled while a previous attempt is still being verified —
  // Argon2id is deliberately slow — and clicking a busy button does nothing.
  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => (node.textContent ?? '').trim() === 'Sign in',
      );
      return button !== undefined && !button.disabled;
    },
    null,
    { timeout },
  );

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await submit.click();

  try {
    if (greeting === undefined) {
      // Any dashboard heading will do; what matters is that the gate is gone.
      await page.getByRole('heading', { name: 'Sign in' }).waitFor({ state: 'detached', timeout });
    } else {
      await page.getByRole('heading', { name: greeting }).waitFor({ timeout });
    }
  } catch (cause) {
    // Say WHY, rather than reporting a timeout on a heading.
    const said = (await page.getByRole('alert').allInnerTexts()).join(' ').trim();
    throw new Error(
      said.length > 0 ? `sign-in as ${email} was refused: ${said}` : cause.message.split('\n')[0],
    );
  }
};

/**
 * Returns the demonstration data to its seeded state.
 *
 * NEEDED NOW IN A WAY IT WAS NOT BEFORE. The demonstration store used to live
 * in the browser, so every run started from the seed by virtue of a fresh
 * profile. It now lives in the SERVER — which is the whole point, since that is
 * where a real database lives — so a second run would otherwise open on the
 * first run's work and find every job already accepted.
 *
 * Masters only, and only where the demonstration backend is running: against
 * PostgreSQL the endpoint does not exist, because a deployment holding a
 * business's data must have no code path that can discard it.
 */
export const resetDemonstration = async (page, base) => {
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await signInAs(page, 'Elmarie Coetzee');

  const status = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/demo/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return response.status;
  }, base);

  if (status !== 200) {
    throw new Error(
      `the demonstration data could not be reset (HTTP ${status}). ` +
        'These suites drive the demonstration backend; start the server without a DATABASE_URL, ' +
        'or with EJE_PERSISTENCE=demo.',
    );
  }

  await signOut(page);
};
