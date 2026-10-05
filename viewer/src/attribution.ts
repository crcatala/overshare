/** The "Created with overshare" credit at the foot of every page. */
import { h } from "./dom.ts";

export const PROJECT_NAME = "overshare";
export const REPO_URL = "https://github.com/crcatala/overshare";
/** The project's home page; there is no separate site yet, so it is the repository. */
export const SITE_URL = REPO_URL;

export function attribution(): HTMLElement {
  const link = (href: string, label: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);
  return h(
    "p",
    { class: "credit" },
    "Created with ",
    link(SITE_URL, PROJECT_NAME),
    h("span", { class: "credit-sep", "aria-hidden": "true" }, "·"),
    link(REPO_URL, "GitHub"),
  );
}
