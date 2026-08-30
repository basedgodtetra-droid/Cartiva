import Link from "next/link";
import { ShoppingBasket } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="site-footer border-t border-[#79bd91]/20 bg-[radial-gradient(circle_at_10%_0%,rgba(37,189,110,0.34),transparent_27rem),radial-gradient(circle_at_92%_96%,rgba(204,240,133,0.12),transparent_29rem),linear-gradient(145deg,#073d29,#061f17_58%,#04130e)] py-4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <div className="footer-grid mx-auto grid w-full max-w-[1240px] gap-3 px-5 sm:px-8 md:grid-cols-[1.35fr_0.65fr_0.8fr]">
        <div className="footer-panel footer-panel--brand rounded-2xl border border-[#bcebc9]/15 bg-white/[0.085] px-5 py-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_60px_rgba(0,0,0,0.12)] sm:px-8 md:py-12">
          <Link href="/" className="inline-flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
            <span className="footer-logo grid size-9 place-items-center rounded-[12px] border border-white/35 bg-gradient-to-br from-[#e1f99b] to-[#aeea8b] text-[#103722] shadow-[0_10px_28px_rgba(155,230,111,0.24),inset_0_1px_0_rgba(255,255,255,0.75)]">
              <ShoppingBasket className="size-4" aria-hidden="true" />
            </span>
            <span className="text-xl font-bold tracking-[-0.04em]">Cartiva</span>
          </Link>
          <p className="mt-6 max-w-md text-sm leading-6 text-[#bdc9c0]">
            Independent grocery comparison for complete, trustworthy baskets. No paid placement. No order or payment handling.
          </p>
        </div>
        <div className="footer-panel footer-panel--explore rounded-2xl border border-[#bcebc9]/15 bg-white/[0.085] px-5 py-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_60px_rgba(0,0,0,0.12)] sm:px-8 md:py-12">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#a9c8b1]">Explore</h2>
          <nav className="mt-6 grid grid-cols-2 gap-2 text-sm font-bold md:grid-cols-1" aria-label="Footer navigation">
            <Link href="/compare" className="footer-cta primary-cta pressable col-span-2 inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8f38f] md:col-span-1">Compare baskets</Link>
            <Link href="/how-it-works" className="footer-link rounded-lg border border-white/10 px-3 py-3 transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8f38f] motion-reduce:transition-none">How it works</Link>
            <Link href="/faq" className="footer-link rounded-lg border border-white/10 px-3 py-3 transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8f38f] motion-reduce:transition-none">FAQ</Link>
            <Link href="/about" className="footer-link col-span-2 rounded-lg border border-white/10 px-3 py-3 transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8f38f] motion-reduce:transition-none md:col-span-1">About</Link>
          </nav>
        </div>
        <div className="footer-panel footer-panel--boundary rounded-2xl border border-[#bcebc9]/15 bg-white/[0.085] px-5 py-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_60px_rgba(0,0,0,0.12)] sm:px-8 md:py-12">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[#a9c8b1]">Where Cartiva stops</h2>
          <p className="mt-6 text-sm leading-6 text-[#bdc9c0]">
            Cartiva compares and hands off. The retailer owns checkout, your order, and payment.
          </p>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10">
        <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-2 px-5 py-5 text-[0.72rem] leading-5 text-[#9bb5a3] sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>© {new Date().getFullYear()} Cartiva</p>
          <p>Prices, availability, taxes, fees, and substitutions are final with the retailer.</p>
        </div>
      </div>
    </footer>
  );
}
