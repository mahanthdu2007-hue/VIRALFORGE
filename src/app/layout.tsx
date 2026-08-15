import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ViralForge AI — long-form video into Shorts',
  description:
    'ViralForge AI finds the strongest moments in your long-form video and forges them into vertical Shorts, using your original audio and footage.',
};

export const viewport: Viewport = {
  themeColor: '#07070b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
