import type { Metadata } from "next";
import { HistoryPage } from "@/components/cartiva-library-pages";

export const metadata: Metadata = { title: "Price history", description: "Review verified, time-stamped Cartiva basket and product price observations." };

export default function Page() { return <HistoryPage />; }
