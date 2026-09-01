"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackCartivaEvent } from "@/lib/cartiva-product-events";

export function CartivaProductEventTracker() {
  const pathname = usePathname();

  useEffect(() => {
    trackCartivaEvent("page_view", { route: pathname });
    if (pathname === "/history") {
      trackCartivaEvent("price_history_viewed", { route: pathname });
    }
  }, [pathname]);

  return null;
}
