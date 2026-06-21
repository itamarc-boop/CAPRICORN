import { Newsreader, Geist, Geist_Mono } from 'next/font/google';

// Display serif for headings — characterful but readable. Used on H1/H2.
export const displaySerif = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

// Body sans — refined modern grotesque, not the AI-default (Inter/Roboto).
export const bodySans = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

// Tabular figures for scores, probabilities, IDs.
export const tabularMono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});
