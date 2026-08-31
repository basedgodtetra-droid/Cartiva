"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CartivaAppNavigation } from "@/components/cartiva-app-navigation";
import { useCartivaLibrary } from "@/components/cartiva-library-provider";
import { SiteFooter } from "@/components/site-footer";
import styles from "@/components/cartiva-workspace.module.css";

export function CartivaLibraryShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const { state } = useCartivaLibrary();
  const latestList = state.lists[0];
  return (
    <div className={styles.app}>
      <CartivaAppNavigation itemCount={latestList?.itemCount ?? 0} currentListName={latestList?.name ?? "Weekly groceries"} />
      <div className={styles.page}>
        <header className={styles.libraryHeader}>
          <div><h1>{title}</h1><p>{description}</p></div>
          <Link href="/compare" className={styles.backToCompare}><ArrowLeft aria-hidden="true" /> Compare a basket</Link>
        </header>
        <main id="main-content" className={styles.libraryPage}>{children}</main>
        <SiteFooter />
      </div>
    </div>
  );
}
