import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import { CartivaAppNavigation } from "@/components/cartiva-app-navigation";
import { SiteFooter } from "@/components/site-footer";
import styles from "@/components/cartiva-workspace.module.css";

interface CartivaShellProps {
  children: ReactNode;
  itemCount: number;
  zipCode: string;
  zipInput: string;
  listName: string;
  locationLabel?: string;
  locationBusy: boolean;
  listSaved: boolean;
  onListName: (value: string) => void;
  onSaveList: () => void;
  onZipInput: (value: string) => void;
  onFindLocation: () => void;
  onNewList: () => void;
}

export function CartivaShell({
  children,
  itemCount,
  zipCode,
  zipInput,
  listName,
  locationLabel,
  locationBusy,
  listSaved,
  onListName,
  onSaveList,
  onZipInput,
  onFindLocation,
  onNewList,
}: CartivaShellProps) {
  return (
    <div className={styles.app}>
      <CartivaAppNavigation itemCount={itemCount} currentListName={listName} onNewList={onNewList} />

      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <label htmlFor="cartiva-list-name" className={styles.srOnly}>List name</label>
            <input
              id="cartiva-list-name"
              className={styles.listNameInput}
              value={listName}
              maxLength={80}
              onChange={(event) => onListName(event.target.value)}
              aria-label="List name"
            />
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
            <button type="button" className={styles.saveListButton} onClick={onSaveList} disabled={!itemCount}>{listSaved ? "Saved" : "Save list"}</button>
            <button type="button" className={styles.newListButton} onClick={onNewList}>New list</button>
          </div>
          <p id="location-summary" className={styles.srOnly} aria-live="polite">
            {locationLabel ? `Selected store: ${locationLabel}` : "No store selected"}
          </p>
        </header>
        {children}
        <SiteFooter />
      </div>
    </div>
  );
}
