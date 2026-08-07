import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Barsoom — Cauchy Array Mars Reconstruction";
  const description = "Retarget a causally honest, entanglement-enhanced reconstruction of Mars from planetary aperture to local observer scale.";
  const image = new URL("/og.png", origin).toString();
  return {
    metadataBase: new URL(origin), title, description,
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: { type: "website", title, description, images: [{ url: image, width: 1727, height: 911, alt: "Barsoom planetary exploration of Mars from orbit to surface" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
