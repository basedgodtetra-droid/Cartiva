"use client";

import Link from "next/link";
import { ArrowUpRight, Menu, ShoppingBasket } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const navigation = [
  { href: "/compare", label: "Compare" },
  { href: "/how-it-works", label: "Method" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" },
];

function NavigationLink({ href, label, mobile = false }: { href: string; label: string; mobile?: boolean }) {
  const pathname = usePathname();
  const active = pathname === href;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        mobile
          ? `mobile-nav-link block min-h-12 border-b border-[#4c8261]/15 px-4 py-3.5 text-sm font-semibold transition duration-200 last:border-b-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#08754d] motion-reduce:transition-none ${active ? "mobile-nav-link--active" : ""}`
          : `nav-link relative flex min-h-9 items-center rounded-full px-4 transition duration-200 ease-out focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#08754d] motion-reduce:transition-none ${active ? "nav-link--active" : ""}`
      }
    >
      {label}
    </Link>
  );
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let current = false;
    const updateScrolled = () => {
      const next = window.scrollY > 8;
      if (next === current) return;
      current = next;
      setScrolled(next);
    };
    const initialCheck = window.setTimeout(updateScrolled, 0);
    window.addEventListener("scroll", updateScrolled, { passive: true });
    return () => {
      window.clearTimeout(initialCheck);
      window.removeEventListener("scroll", updateScrolled);
    };
  }, []);

  return (
    <>
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-xl bg-[#174f38] px-4 py-2 text-sm font-bold text-white shadow-lg transition focus:translate-y-0 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <header className={`site-header sticky top-0 z-50 transition duration-300 ease-out motion-reduce:transition-none ${scrolled ? "site-header--scrolled" : ""}`}>
        <div className="site-header-shell mx-auto flex min-h-16 w-full max-w-[1240px] items-center justify-between px-5 sm:px-8">
          <Link
            href="/"
            className="site-brand group flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#174f38]"
            aria-label="Cartiva home"
          >
            <span className="site-brand-icon grid size-9 place-items-center rounded-[12px] border border-white/50 bg-gradient-to-br from-[#17a96f] via-[#08754d] to-[#063e2c] text-white shadow-[0_9px_24px_rgba(6,117,74,0.3),0_0_24px_rgba(43,181,104,0.12),inset_0_1px_0_rgba(255,255,255,0.34)]">
              <ShoppingBasket className="size-4" strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="site-wordmark text-[1.08rem] font-bold tracking-[-0.035em]">Cartiva</span>
            <span className="brand-tagline hidden rounded-full border border-[#78ac89]/20 bg-[#edf8db]/68 px-2.5 py-1 text-[0.7rem] font-semibold tracking-[-0.01em] text-[#52695a] shadow-[inset_0_1px_0_rgba(255,255,255,0.84)] sm:inline">
              Grocery intelligence
            </span>
          </Link>

          <div className="flex items-center gap-2">
            <nav className="site-nav hidden items-center gap-1 rounded-full border border-[#a8c8b2]/40 bg-white/72 p-1 text-sm font-semibold text-[#536059] shadow-[inset_0_1px_0_rgba(255,255,255,0.94),0_7px_24px_rgba(4,76,46,0.09)] md:flex" aria-label="Main navigation">
              {navigation.map((item) => (
                <NavigationLink key={item.href} {...item} />
              ))}
            </nav>

            <details className="site-mobile-menu relative flex items-center md:hidden">
              <summary className="site-mobile-trigger grid min-h-11 min-w-11 cursor-pointer list-none place-items-center rounded-xl border border-white/75 bg-white/72 text-[#314037] shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#174f38] [&::-webkit-details-marker]:hidden">
                <Menu className="size-5" aria-hidden="true" />
                <span className="sr-only">Open navigation</span>
              </summary>
              <nav className="glass-surface-strong fixed left-4 right-4 top-[72px] overflow-hidden rounded-2xl" aria-label="Mobile navigation">
                {navigation.map((item) => (
                  <NavigationLink key={item.href} {...item} mobile />
                ))}
              </nav>
            </details>
            <Link
              href="/compare"
              className="site-header-cta primary-cta pressable inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#08754d] sm:px-5"
            >
              <span className="hidden sm:inline">Start a comparison</span>
              <span className="sm:hidden">Compare</span>
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
