import type { ReactNode } from "react";
import { Bookmark, Clock3, List, MapPin, Menu, Plus, ReceiptText } from "lucide-react";
import { CartivaLogo } from "@/components/cartiva-logo";
import styles from "@/components/cartiva-workspace.module.css";

interface CartivaShellProps {
  children: ReactNode;
  itemCount: number;
  zipCode: string;
  zipInput: string;
  locationLabel?: string;
  locationBusy: boolean;
  onZipInput: (value: string) => void;
  onFindLocation: () => void;
  onNewList: () => void;
}

export function CartivaShell({
  children,
  itemCount,
  zipCode,
  zipInput,
  locationLabel,
  locationBusy,
  onZipInput,
  onFindLocation,
  onNewList,
}: CartivaShellProps) {
  const countLabel = `${itemCount} ${itemCount === 1 ? "item" : "items"}`;

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar} aria-label="Cartiva workspace navigation">
        <CartivaLogo className={styles.logo} markClassName={styles.logoMark} />
        <p className={styles.navEyebrow}>Workspace</p>
        <nav className={styles.navList}>
          <a href="#compare" className={`${styles.navItem} ${styles.navItemActive}`} aria-current="page">
            <List aria-hidden="true" />
            Compare baskets
          </a>
          <span className={styles.navItem} aria-disabled="true"><ReceiptText aria-hidden="true" /> My lists</span>
          <span className={styles.navItem} aria-disabled="true"><Bookmark aria-hidden="true" /> Saved baskets</span>
          <span className={styles.navItem} aria-disabled="true"><Clock3 aria-hidden="true" /> Price history</span>
        </nav>

        <p className={styles.navEyebrow}>This week</p>
        <div className={styles.weekCard}>
          <span>Weekly groceries</span>
          <strong>{countLabel}</strong>
          <small>{itemCount ? "Ready to compare" : "Start a list"}</small>
        </div>

        <div className={styles.sidebarFoot}>
          <span className={styles.avatar}>J</span>
          <span><strong>Josh</strong><small>Cartiva workspace</small></span>
        </div>
      </aside>

      <div className={styles.mobileBar}>
        <button type="button" className={styles.iconButton} aria-label="Open navigation">
          <Menu aria-hidden="true" />
        </button>
        <CartivaLogo className={styles.mobileLogo} markClassName={styles.mobileLogoMark} />
        <button type="button" className={styles.mobileNewButton} onClick={onNewList}>
          <Plus aria-hidden="true" /> New
        </button>
      </div>

      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>Weekly grocery run</h1>
            <p>Compare the list, then hand off one complete basket.</p>
          </div>
          <div className={styles.headerActions}>
            <form
              className={styles.locationForm}
              onSubmit={(event) => {
                event.preventDefault();
                onFindLocation();
              }}
            >
              <MapPin aria-hidden="true" />
              <label htmlFor="cartiva-zip" className={styles.srOnly}>ZIP code</label>
              <input
                id="cartiva-zip"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={5}
                value={zipInput}
                onChange={(event) => onZipInput(event.target.value.replace(/\D/g, "").slice(0, 5))}
                placeholder="ZIP code"
                aria-describedby="location-summary"
                aria-invalid={Boolean(zipInput) && !/^\d{5}$/.test(zipInput)}
              />
              <button type="submit" disabled={locationBusy || !/^\d{5}$/.test(zipInput)}>
                {locationBusy ? "Finding stores…" : zipCode === zipInput && locationLabel ? "Change" : "Find"}
              </button>
            </form>
            <button type="button" className={styles.newListButton} onClick={onNewList}>New list</button>
          </div>
          <p id="location-summary" className={styles.srOnly} aria-live="polite">
            {locationLabel ? `Selected store: ${locationLabel}` : "No store selected"}
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}
