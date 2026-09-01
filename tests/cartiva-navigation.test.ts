import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cartivaAppRoutes } from "@/components/cartiva-app-navigation";
import { SiteFooter } from "@/components/site-footer";

const projectRoot = process.cwd();
const footerRoutes = [
  "/how-it-works",
  "/about",
  "/contact",
  "/data-sourcing",
  "/retailer-independence",
  "/accessibility",
  "/terms",
  "/privacy",
];

describe("Cartiva navigation", () => {
  it("links every workspace destination to a real page", () => {
    expect(cartivaAppRoutes.map((route) => route.href)).toEqual([
      "/compare",
      "/library",
      "/history",
    ]);
    for (const route of cartivaAppRoutes) {
      expect(existsSync(path.join(projectRoot, "app", route.href.slice(1), "page.tsx"))).toBe(true);
    }
    for (const relatedRoute of ["/lists", "/baskets"]) {
      expect(existsSync(path.join(projectRoot, "app", relatedRoute.slice(1), "page.tsx"))).toBe(true);
    }
    const source = readFileSync(path.join(projectRoot, "components", "cartiva-app-navigation.tsx"), "utf8");
    expect(source).not.toContain('aria-disabled="true"');
    expect(source).not.toContain('href="#compare"');
    expect(source).toContain('aria-current={active ? "page" : undefined}');
    expect(source).toContain('related: ["/lists", "/baskets"]');
    const workspaceSource = readFileSync(path.join(projectRoot, "components", "cartiva-workspace.tsx"), "utf8");
    expect(workspaceSource).not.toContain("CartivaUtilityRail");
    expect(workspaceSource).not.toContain("styles.summaryBar");
  });

  it("renders a compact footer whose links all resolve", () => {
    const markup = renderToStaticMarkup(createElement(SiteFooter));
    for (const route of footerRoutes) {
      expect(markup).toContain(`href="${route}"`);
      expect(existsSync(path.join(projectRoot, "app", route.slice(1), "page.tsx"))).toBe(true);
    }
    expect(markup).toContain("© 2026 Cartiva. All rights reserved.");
    expect(markup).toContain("do not necessarily imply sponsorship or endorsement");
    expect(markup).not.toContain("footer-panel");
  });

  it("keeps the legal drafts marked for professional review", () => {
    for (const route of ["terms", "privacy"]) {
      const source = readFileSync(path.join(projectRoot, "app", route, "page.tsx"), "utf8");
      expect(source).toContain("legalReview");
    }
  });
});
