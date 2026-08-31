import Link from "next/link";
import type { ReactNode } from "react";
import { CartivaLogo } from "@/components/cartiva-logo";
import { SiteFooter } from "@/components/site-footer";

export function CartivaInformationPage({
  eyebrow,
  title,
  lede,
  updated,
  legalReview = false,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  updated?: string;
  legalReview?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="cartiva-info">
      <header className="cartiva-info__bar">
        <div className="cartiva-info__bar-inner">
          <Link href="/compare" className="cartiva-info__home" aria-label="Cartiva comparison workspace">
            <CartivaLogo className="cartiva-info__logo" markClassName="cartiva-info__mark" />
          </Link>
          <Link href="/compare" className="cartiva-info__compare">Compare a basket</Link>
        </div>
      </header>
      <main id="main-content">
        <article className="cartiva-info__document" data-legal-review={legalReview ? "required-before-public-launch" : undefined}>
          <p className="cartiva-info__eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="cartiva-info__lede">{lede}</p>
          {updated ? <p className="cartiva-info__updated">Last updated {updated}</p> : null}
          <div className="cartiva-info__content">{children}</div>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
