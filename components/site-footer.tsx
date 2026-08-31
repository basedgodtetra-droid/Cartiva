import Link from "next/link";
import { CartivaLogo } from "@/components/cartiva-logo";

const footerGroups = [
  {
    label: "Cartiva",
    links: [
      ["How it works", "/how-it-works"],
      ["About", "/about"],
      ["Contact", "/contact"],
    ],
  },
  {
    label: "Trust",
    links: [
      ["Data & sourcing", "/data-sourcing"],
      ["Retailer independence", "/retailer-independence"],
      ["Accessibility", "/accessibility"],
    ],
  },
  {
    label: "Legal",
    links: [
      ["Terms of Service", "/terms"],
      ["Privacy Policy", "/privacy"],
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="cartiva-footer">
      <div className="cartiva-footer__main">
        <div className="cartiva-footer__brand">
          <Link href="/compare" aria-label="Cartiva comparison workspace">
            <CartivaLogo className="cartiva-footer__logo" markClassName="cartiva-footer__mark" />
          </Link>
          <p>Independent grocery comparison built around complete, verifiable baskets.</p>
        </div>
        <div className="cartiva-footer__links">
          {footerGroups.map((group) => (
            <nav aria-label={`${group.label} footer links`} key={group.label}>
              <h2>{group.label}</h2>
              {group.links.map(([label, href]) => <Link href={href} key={href}>{label}</Link>)}
            </nav>
          ))}
        </div>
      </div>
      <div className="cartiva-footer__fineprint">
        <p>© 2026 Cartiva. All rights reserved.</p>
        <p>Retailer names and trademarks belong to their respective owners. References identify retailers and do not necessarily imply sponsorship or endorsement.</p>
      </div>
    </footer>
  );
}
