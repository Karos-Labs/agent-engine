import type { Metadata } from "next";
/* FONTS — the second skin lever. Swap these three next/font/google families
   per client; the CSS variable role names (--font-display-family /
   --font-sans-family / --font-mono-family) stay constant and are mapped to the
   semantic --font-display / --font-sans / --font-mono tokens in globals.css.
   DEFAULT is a NEUTRAL placeholder set. TODO(per client): change families only. */
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { example } from "@/content/example";

// TODO(per client): display family — bold, characterful, for headlines + key figures.
const displayFont = Space_Grotesk({
  variable: "--font-display-family",
  subsets: ["latin"],
  display: "swap",
});

// TODO(per client): body family — highly legible UI/body sans.
const sansFont = Inter({
  variable: "--font-sans-family",
  subsets: ["latin"],
  display: "swap",
});

// TODO(per client): mono family — numbers, labels, eyebrows.
const monoFont = JetBrains_Mono({
  variable: "--font-mono-family",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Metadata is content-driven — no hardcoded brand strings.
export const metadata: Metadata = {
  title: example.meta.title,
  description: example.meta.description,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang={example.lang}
      className={`${displayFont.variable} ${sansFont.variable} ${monoFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
