/**
 * The demonstration password, stated on the screen that asks for it.
 *
 * EVERY SEEDED USER SHARES ONE PASSWORD, and the sign-in screen says so. There
 * are no real people behind the seeded names, so inventing individual passwords
 * would be pretending otherwise — and a demonstration whose credentials are a
 * secret is a demonstration nobody can give.
 *
 * It is only ever accepted by `DemoAuthStore`, which is built only when the
 * server has explicitly chosen the demonstration backend. A deployment with a
 * `DATABASE_URL` never constructs it, so this cannot become a way into the
 * business's data.
 */
export const DEMO_PASSWORD = 'eje-demo';

export const DEMO_PASSWORD_HINT =
  `Demonstration build: every seeded account uses the password “${DEMO_PASSWORD}”. ` +
  'Try elmarie.coetzee@eje-demo.co.za for the office, or sipho.mahlangu@eje-demo.co.za for a field technician.';
