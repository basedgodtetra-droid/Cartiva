import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CARTIVA_MOTTOS,
  CartivaMotto,
  chooseCartivaMotto,
} from "@/components/cartiva-motto";

describe("Cartiva motto selection", () => {
  it.each(CARTIVA_MOTTOS)(
    "does not repeat $id on the next session",
    (previousMotto) => {
      expect(chooseCartivaMotto(previousMotto.id, 0).id).not.toBe(
        previousMotto.id,
      );
      expect(chooseCartivaMotto(previousMotto.id, 0.999).id).not.toBe(
        previousMotto.id,
      );
    },
  );

  it("randomizes across both eligible alternatives", () => {
    const first = chooseCartivaMotto(CARTIVA_MOTTOS[0].id, 0).id;
    const second = chooseCartivaMotto(CARTIVA_MOTTOS[0].id, 0.999).id;

    expect(first).not.toBe(second);
    expect([first, second]).toEqual(
      expect.arrayContaining([
        CARTIVA_MOTTOS[1].id,
        CARTIVA_MOTTOS[2].id,
      ]),
    );
  });

  it("can choose from all three mottos without a previous visit", () => {
    const selections = [0, 0.34, 0.999].map(
      (randomValue) => chooseCartivaMotto(null, randomValue).id,
    );

    expect(new Set(selections)).toEqual(
      new Set(CARTIVA_MOTTOS.map((motto) => motto.id)),
    );
  });

  it("owns the primary hero heading instead of rendering a separate label", () => {
    const markup = renderToStaticMarkup(createElement(CartivaMotto));

    expect(markup).toContain("<h1");
    expect(markup).toContain("cartiva-motto-heading");
    expect(markup).toContain("cartiva-motto-heading__emphasis");
    expect(markup).toContain("Smarter carts.");
    expect(markup).not.toContain("aria-hidden");
    expect(markup).not.toContain("placeholder");
    expect(markup).not.toContain("<p");
  });
});
