import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const dmSans = localFont({ src: "../../public/fonts/dm-sans-latin.woff2", weight: "400 700", variable: "--font-dm-sans", display: "swap" });
const spaceGrotesk = localFont({ src: "../../public/fonts/space-grotesk-latin.woff2", weight: "400 700", variable: "--font-space-grotesk", display: "swap" });
const plexMono = localFont({ src: "../../public/fonts/ibm-plex-mono-latin.woff2", weight: "400", variable: "--font-plex-mono", display: "swap", preload: false });

export const metadata: Metadata = {
  metadataBase: new URL("https://agendia-app.pages.dev"),
  title: "AgendIA | Tus clientes agendan, la IA trabaja",
  description: "Servicios, disponibilidad y agenda para tu negocio. Asistente virtual: Sarin Bot. Desarrollado por ALS Dev Studio.",
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/brand/agendia-icon.svg", type: "image/svg+xml" },
      { url: "/brand/agendia-192.png", type: "image/png", sizes: "192x192" },
      { url: "/brand/agendia-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/brand/agendia-192.png", type: "image/png", sizes: "192x192" }],
  },
  openGraph: {
    type: "website", locale: "es_CO", siteName: "AgendIA",
    title: "AgendIA | Tus clientes agendan, la IA trabaja",
    description: "Reservas por conversación, enlace y QR para tus clientes. Asistente virtual: Sarin Bot. Desarrollado por ALS Dev Studio.",
    url: "/",
  },
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" data-scroll-behavior="smooth" className={`${dmSans.variable} ${spaceGrotesk.variable} ${plexMono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
