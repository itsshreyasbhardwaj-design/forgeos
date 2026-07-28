import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'ForgeOS — the developer operating system',
    template: '%s · ForgeOS',
  },
  description:
    'Repository intelligence, documentation, architecture, evaluation, automation, memory, workflows, APIs and security — one platform, one AI, one interface.',
  applicationName: 'ForgeOS',
  keywords: ['developer tools', 'code analysis', 'documentation', 'AI', 'workflows', 'security'],
  authors: [{ name: 'ForgeOS contributors' }],
  openGraph: {
    title: 'ForgeOS',
    description: 'The AI-powered developer operating system.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#111214' },
  ],
};

/**
 * Applied before first paint so the correct theme is present in the very first
 * frame. Doing this in an effect instead produces a visible flash of the wrong
 * theme on every hard navigation.
 */
const THEME_SCRIPT = `(function(){try{var stored=localStorage.getItem('forgeos-theme');var prefers=window.matchMedia('(prefers-color-scheme: dark)').matches;var theme=stored||(prefers?'dark':'light');document.documentElement.setAttribute('data-theme',theme);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/* Keyboard users must be able to reach content without tabbing the nav. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--forge-accent)] focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
