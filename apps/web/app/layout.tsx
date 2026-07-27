import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Sightline — family office intelligence',
  description: 'Verified family office records for capital allocators, with the basis for every value shown.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
