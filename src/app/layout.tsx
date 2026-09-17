import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AppProvider } from '@/providers/AppProvider';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'EJE Job Card Management',
    template: '%s · EJE Job Card Management',
  },
  description:
    'Job card management for EJE Industrial Electronics — jobs, customers, machines, checklists and technical documentation.',
  applicationName: 'EJE Job Card Management',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Rugged tablets are the primary field device; the layout is built for them.
  maximumScale: 5,
  themeColor: '#1b2434',
};

const RootLayout = ({ children }: { readonly children: React.ReactNode }) => (
  <html
    lang="en-ZA"
    // Rendered light; the boot script below corrects this before first paint if
    // the viewer has chosen otherwise, so the theme never flashes.
    data-theme="light"
    className={`${inter.variable} ${jetbrainsMono.variable}`}
    suppressHydrationWarning
  >
    <head>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
    </head>
    <body className="min-h-dvh antialiased">
      <AppProvider>{children}</AppProvider>
    </body>
  </html>
);

export default RootLayout;
