import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import "./globals.css";

const canonicalOrigin = new URL("https://cartiva-complete-cart.basedgodtetra.chatgpt.site");

const socialImage = new URL("/og.png", canonicalOrigin).toString();

export const metadata: Metadata = {
  metadataBase: canonicalOrigin,
  title: {
    default: `${siteConfig.name} — Complete grocery cart comparison`,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  category: "shopping",
  keywords: ["grocery comparison", "grocery prices", "complete basket", "shopping list"],
  openGraph: {
    title: "Cartiva — Compare the full cart",
    description: siteConfig.description,
    siteName: siteConfig.name,
    type: "website",
    url: canonicalOrigin.toString(),
    images: [{ url: socialImage, width: 1728, height: 906, alt: "Cartiva compares one grocery list across complete retailer baskets." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Cartiva — Compare the full cart",
    description: siteConfig.description,
    images: [socialImage],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
