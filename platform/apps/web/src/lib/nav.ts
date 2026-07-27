/**
 * The product's navigation vocabulary, in one place.
 *
 * Every page renders these exact labels in this exact order, so a link
 * never changes name between `/`, `/app` and `/data`. `id` is what a page
 * passes as `active` to mark the current section.
 */

export type NavId = "home" | "app" | "data" | "hedge" | "pricing";

export interface NavLink {
  id: NavId;
  label: string;
  href: string;
}

export const NAV_LINKS: NavLink[] = [
  { id: "app", label: "Liquidity Studio", href: "/app" },
  { id: "data", label: "Data", href: "/data" },
  { id: "hedge", label: "Hedging", href: "/#hedge" },
  { id: "pricing", label: "Pricing", href: "/#pricing" },
];
