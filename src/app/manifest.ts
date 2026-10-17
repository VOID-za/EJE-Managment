import type { MetadataRoute } from 'next';
import { EJE_THEME_COLOR } from '@/lib/theme';

/**
 * THE INSTALLED APPLICATION. PWA-1, PWA-2, MANDATE-2, CR-03.
 *
 * Next's own `app/manifest.ts` convention rather than a hand-written file in
 * `public/`: the framework serves it at `/manifest.webmanifest` with the right
 * content type and links it from every document, which is one less thing to
 * get wrong and nothing extra to install.
 *
 * WHAT MAKES IT INSTALLABLE, and the parts that are not decoration:
 *
 *   - `display: 'standalone'` is PWA-2. Launched from the home screen there is
 *     no address bar and no browser chrome, which on a rugged tablet is the
 *     difference between an application and a bookmark — and it is also what
 *     stops a technician navigating away mid-capture by tapping something in
 *     the browser's own furniture.
 *   - `start_url` and `scope` are both `/`. The application is one origin and
 *     every screen belongs to it; a narrower scope would push the sign-in page
 *     out of the installed app.
 *   - Two icon sizes plus a MASKABLE one. Android crops an icon to whatever
 *     shape the launcher uses, and an icon without a maskable variant gets its
 *     corners cut off or a white box drawn behind it.
 *
 * `theme_color` is the same navy as the document's own `theme-color`, from the
 * one constant both read (`EJE_THEME_COLOR`), so the system bars match the
 * application rather than flashing white at launch.
 *
 * WHAT IS DELIBERATELY ABSENT: `screenshots` and `shortcuts`. Both are real
 * manifest features and both would be invented product decisions — which
 * screens EJE want on a long-press menu is theirs to make.
 */
const manifest = (): MetadataRoute.Manifest => ({
  name: 'EJE Job Card Management',
  short_name: 'EJE Job Cards',
  description:
    'Job cards for EJE Industrial Electronics — accept work, capture labour, travel, parts and photographs, and take the customer’s signature on site.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: EJE_THEME_COLOR,
  theme_color: EJE_THEME_COLOR,
  categories: ['business', 'productivity'],
  lang: 'en-ZA',
  dir: 'ltr',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
});

export default manifest;
