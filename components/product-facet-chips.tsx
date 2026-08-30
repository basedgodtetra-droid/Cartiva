"use client";

import { Sparkles } from "lucide-react";
import {
  analyzeProductFacets,
  selectFacetOption,
} from "@/lib/product-facets";

interface ProductFacetChipsProps {
  query: string;
  selectedOptionIds: string[];
  onChange: (optionIds: string[]) => void;
}

export function ProductFacetChips({
  query,
  selectedOptionIds,
  onChange,
}: ProductFacetChipsProps) {
  const request = analyzeProductFacets(query, selectedOptionIds);
  if (!request.category || !request.groups.length) return null;

  return (
    <section
      className="mt-3 rounded-2xl border border-[#dfe5da] bg-[#f6f8f1] p-3.5"
      aria-label={`Optional smart options for ${query}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-extrabold text-[#385143]">
          <Sparkles className="size-3.5 text-[#6f9821]" aria-hidden="true" />
          Smart options for {request.categoryLabel?.toLowerCase()}
        </p>
        <span className="text-[0.68rem] font-semibold text-[#748078]">Optional</span>
      </div>

      <div className="mt-3">
        <button
          type="button"
          aria-pressed={request.selectedOptionIds.length === 0}
          onClick={() => onChange([])}
          className={`min-h-10 rounded-xl px-3 py-2 text-left text-xs font-bold leading-4 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] motion-reduce:transition-none ${
            request.selectedOptionIds.length === 0
              ? "bg-[#d8f44b] text-[#21311e] ring-1 ring-inset ring-[#bedb32]"
              : "bg-white text-[#435149] ring-1 ring-inset ring-[#d9dfd7] hover:ring-[#aebcaf]"
          }`}
        >
          Auto — choose the cheapest reasonable option.
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {request.groups.map((facetGroup) => (
          <fieldset key={facetGroup.id}>
            <legend className="mb-1.5 text-[0.66rem] font-bold uppercase tracking-[0.11em] text-[#778078]">
              {facetGroup.label}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {facetGroup.options.map((facetOption) => (
                <button
                  key={facetOption.id}
                  type="button"
                  aria-pressed={facetOption.selected}
                  aria-label={`Select ${facetOption.label} for ${query}`}
                  onClick={() => onChange(selectFacetOption(
                    query,
                    request.selectedOptionIds,
                    facetOption.id,
                  ))}
                  className={`min-h-10 rounded-xl px-3 py-2 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14613f] motion-reduce:transition-none ${
                    facetOption.selected
                      ? "bg-[#0d5c3b] text-white shadow-[0_4px_10px_rgba(13,92,59,0.14)]"
                      : "bg-white text-[#35433b] ring-1 ring-inset ring-[#d9dfd7] hover:bg-[#fbfcf8] hover:ring-[#aebcaf]"
                  }`}
                >
                  {facetOption.label}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {request.selectedOptionIds.length
          ? `${request.selectedOptionIds.length} smart option selected.`
          : "Automatic product choice selected."}
      </p>
    </section>
  );
}
