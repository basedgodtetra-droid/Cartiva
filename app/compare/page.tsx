import type { Metadata } from "next";
import { CartivaWorkspace } from "@/components/cartiva-workspace";

export const metadata: Metadata = {
  title: "Compare complete grocery baskets",
  description: "Build one grocery list, compare verified exact-store products, and hand off a complete basket to the retailer.",
};

type ComparePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const params = await searchParams;
  const loadListId = firstValue(params.list)?.trim();
  const loadBasketId = firstValue(params.basket)?.trim();
  return <CartivaWorkspace loadListId={loadListId} loadBasketId={loadBasketId} />;
}
