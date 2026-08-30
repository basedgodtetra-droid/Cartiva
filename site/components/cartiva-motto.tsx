"use client";

import { useEffect, useRef, useState } from "react";

export const CARTIVA_MOTTOS = [
  {
    id: "cart-best-price",
    lead: "Your cart.",
    emphasis: "Your best price.",
  },
  {
    id: "smarter-smaller",
    lead: "Smarter carts.",
    emphasis: "Smaller totals.",
  },
  {
    id: "shop-spend",
    lead: "Shop smarter.",
    emphasis: "Spend less.",
  },
] as const;

type Motto = (typeof CARTIVA_MOTTOS)[number];

const CURRENT_SESSION_KEY = "cartiva:motto:current:v1";
const PREVIOUS_VISIT_KEY = "cartiva:motto:previous:v1";

function findMotto(id: string | null) {
  return CARTIVA_MOTTOS.find((motto) => motto.id === id) ?? null;
}

export function chooseCartivaMotto(
  previousId: string | null,
  randomValue = Math.random(),
): Motto {
  const alternatives = CARTIVA_MOTTOS.filter(
    (motto) => motto.id !== previousId,
  );
  const candidates = alternatives.length > 0 ? alternatives : CARTIVA_MOTTOS;
  const unitValue = Number.isFinite(randomValue)
    ? Math.abs(randomValue % 1)
    : 0;

  return candidates[Math.floor(unitValue * candidates.length)] ?? candidates[0];
}

function getSessionMotto() {
  let currentId: string | null = null;

  try {
    currentId = window.sessionStorage.getItem(CURRENT_SESSION_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browsing contexts.
  }

  const currentMotto = findMotto(currentId);
  if (currentMotto) {
    return currentMotto;
  }

  let previousId: string | null = null;

  try {
    previousId = window.localStorage.getItem(PREVIOUS_VISIT_KEY);
  } catch {
    // The motto still works without persistence when local storage is blocked.
  }

  const selectedMotto = chooseCartivaMotto(previousId);

  try {
    window.sessionStorage.setItem(CURRENT_SESSION_KEY, selectedMotto.id);
  } catch {
    // Keep the in-memory selection stable for the current page lifecycle.
  }

  try {
    window.localStorage.setItem(PREVIOUS_VISIT_KEY, selectedMotto.id);
  } catch {
    // No tracking or backend fallback is needed for this preference.
  }

  return selectedMotto;
}

type CartivaMottoProps = {
  className?: string;
};

export function CartivaMotto({ className }: CartivaMottoProps) {
  const [motto, setMotto] = useState<Motto | null>(null);
  const selectedMottoRef = useRef<Motto | null>(null);

  useEffect(() => {
    const selectedMotto = selectedMottoRef.current ?? getSessionMotto();
    selectedMottoRef.current = selectedMotto;
    setMotto(selectedMotto);
  }, []);

  const displayedMotto = motto ?? CARTIVA_MOTTOS[1];

  return (
    <div
      className={["cartiva-motto-headline-shell", className]
        .filter(Boolean)
        .join(" ")}
    >
      <h1
        className="cartiva-motto-heading hero-enter hero-enter--2 home-hero-title hero-title-gradient text-[clamp(2.8rem,6vw,5.6rem)] font-semibold leading-[0.93] tracking-[-0.06em]"
      >
        <span>{displayedMotto.lead}</span>
        <br />
        <strong className="cartiva-motto-heading__emphasis home-hero-title-accent">
          {displayedMotto.emphasis}
        </strong>
      </h1>
    </div>
  );
}
