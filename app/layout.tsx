import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "barsoom.openai.site";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Barsoom — Seamless Mars Planetary Survey";
  const description = "Navigate continuously from Mars orbit to MOLA-based terrain in a fully client-side Three.js planetary renderer.";
  const image = new URL("/og.png", origin).toString();
  return {
    metadataBase: new URL(origin), title, description,
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: { type: "website", title, description, images: [{ url: image, width: 1200, height: 630, alt: "Barsoom seamless Mars planetary survey" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
