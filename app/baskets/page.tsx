import type { Metadata } from "next";
import { BasketsPage } from "@/components/cartiva-library-pages";

export const metadata: Metadata = { title: "Saved baskets", description: "Review historical Cartiva basket comparisons and check current prices again." };

export default function Page() { return <BasketsPage />; }
