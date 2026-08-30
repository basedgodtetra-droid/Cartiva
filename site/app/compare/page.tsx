import type { Metadata } from "next";

import { ComparisonExperience } from "@/components/comparison-experience";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { PREVIEW_LIST, PREVIEW_ZIP } from "@/lib/comparison-preview";

export const metadata: Metadata = {
  title: "Compare complete grocery baskets",
  description:
    "Preview how Cartiva matches one grocery list across retailers, compares only complete baskets, labels every data source, and hands checkout back to the retailer.",
};

type ComparePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const params = await searchParams;
  const suppliedList = firstValue(params.list)?.trim();
  const suppliedZip = firstValue(params.zip)?.trim();
  const initialList = suppliedList || PREVIEW_LIST;
  const initialZip = suppliedZip || PREVIEW_ZIP;
  const autoStart = Boolean(suppliedList && /^\d{5}$/.test(suppliedZip ?? ""));

  return (
    <div className="min-h-screen bg-transparent text-[#17211b]">
      <SiteHeader />
      <main id="main-content" className="comparison-page bg-[radial-gradient(circle_at_10%_10%,rgba(28,177,105,0.2),transparent_30rem),radial-gradient(circle_at_92%_16%,rgba(211,241,154,0.16),transparent_31rem)]">
        <div className="mx-auto w-full max-w-[1240px] px-5 py-12 sm:px-8 sm:py-16 lg:py-20">
          <ComparisonExperience initialList={initialList} initialZip={initialZip} autoStart={autoStart} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
