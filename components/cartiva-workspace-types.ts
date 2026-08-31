import type { KrogerMatchResult } from "@/lib/types";

export interface CartivaLocation {
  locationId: string;
  name: string;
  chain: string;
  address: {
    addressLine1: string;
    city: string;
    state: string;
    zipCode: string;
  };
}

export type ComparisonPhase = "idle" | "finding-store" | "searching" | "complete" | "error";

export interface ComparisonState {
  phase: ComparisonPhase;
  results: Array<KrogerMatchResult | null>;
  completedItems: number;
  checkedAt?: string;
  message?: string;
}

export type CartPhase = "idle" | "connecting" | "adding" | "success" | "error";

export interface CartState {
  phase: CartPhase;
  message?: string;
  cartUrl?: string;
}
