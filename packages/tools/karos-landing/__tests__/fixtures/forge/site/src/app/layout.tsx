import type { Metadata } from "next";
import { Archivo, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/* Display: spec calls for Clash Display (Fontshare). Archivo is the closest heavy
   grotesque available via next/font/google, so the fixture builds with zero external
   font hosting. Same intent: heavy, confident, athletic headlines + big numbers. */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "FORGE · Train like an athlete, not a tourist",
  description:
    "An adaptive strength program built around you. FORGE tracks every session and adjusts the next block from what you actually lifted. 50,000+ athletes, 2M+ workouts logged.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
