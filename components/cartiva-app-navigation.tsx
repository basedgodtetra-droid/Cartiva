"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Clock3, Library, List, Menu, Plus, X } from "lucide-react";
import { CartivaLogo } from "@/components/cartiva-logo";
import styles from "@/components/cartiva-workspace.module.css";

export const cartivaAppRoutes = [
  { href: "/compare", label: "Compare", icon: List, related: ["/"] },
  { href: "/library", label: "Library", icon: Library, related: ["/lists", "/baskets"] },
  { href: "/history", label: "Price history", icon: Clock3, related: [] },
] as const;

function AppLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className={styles.navList} aria-label="Cartiva workspace navigation links">
      {cartivaAppRoutes.map(({ href, label, icon: Icon, related }) => {
        const active = pathname === href || related.some((path) => path === pathname);
        return (
          <Link
            key={href}
            href={href}
            className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
          >
            <Icon aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

interface CartivaAppNavigationProps {
  itemCount: number;
  currentListName: string;
  onNewList?: () => void;
  newListDisabled?: boolean;
}

export function CartivaAppNavigation({ itemCount, currentListName, onNewList, newListDisabled = false }: CartivaAppNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const countLabel = `${itemCount} ${itemCount === 1 ? "item" : "items"}`;

  useEffect(() => {
    if (!menuOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const menu = menuRef.current;
    const focusable = () => [...(menu?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [menuOpen]);

  return (
    <>
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <aside className={styles.sidebar} aria-label="Cartiva workspace navigation">
        <CartivaLogo className={styles.logo} markClassName={styles.logoMark} />
        <p className={styles.navEyebrow}>Shop</p>
        <AppLinks />

      </aside>

      <div className={styles.mobileBar}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Open navigation"
          aria-expanded={menuOpen}
          aria-controls="cartiva-mobile-menu"
          onClick={() => setMenuOpen(true)}
        >
          <Menu aria-hidden="true" />
        </button>
        <CartivaLogo className={styles.mobileLogo} markClassName={styles.mobileLogoMark} />
        {onNewList ? (
          <button type="button" className={styles.mobileNewButton} onClick={onNewList} disabled={newListDisabled}>
            <Plus aria-hidden="true" /> New
          </button>
        ) : <span className={styles.mobileBarSpacer} aria-hidden="true" />}
      </div>

      {menuOpen ? (
        <div className={styles.mobileMenuBackdrop} role="presentation" onMouseDown={() => setMenuOpen(false)}>
          <section
            id="cartiva-mobile-menu"
            ref={menuRef}
            className={styles.mobileMenu}
            role="dialog"
            aria-modal="true"
            aria-label="Cartiva navigation"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={styles.mobileMenuHeader}>
              <CartivaLogo className={styles.mobileLogo} markClassName={styles.mobileLogoMark} />
              <button type="button" className={styles.iconButton} onClick={() => setMenuOpen(false)} aria-label="Close navigation">
                <X aria-hidden="true" />
              </button>
            </div>
            <p className={styles.navEyebrow}>Your Cartiva</p>
            <AppLinks onNavigate={() => setMenuOpen(false)} />
            <div className={styles.mobileMenuSummary}>
              <strong>{currentListName}</strong>
              <span>{countLabel} · saved locally when you choose Save list</span>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
