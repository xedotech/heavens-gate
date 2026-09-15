import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-ui', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-data', subsets: ['latin'] });
const siteUrl = new URL('https://heavens-gate-aethel.xedos.chatgpt.site');

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "Heaven's Gate — Open World Prototype",
  description: 'An original open-source celestial-noir action game built for modern desktop browsers and gamepads.',
  icons: { icon: '/favicon.svg' },
  alternates: { canonical: '/' },
  openGraph: {
    title: "Heaven's Gate",
    description: 'The city remembers every choice. The sky remembers every name.',
    type: 'website',
    url: '/',
    images: [{ url: '/og.png', width: 1664, height: 936, alt: "Heaven's Gate — The City Remembers" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Heaven's Gate",
    description: 'An original open-source celestial-noir action game.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
