/** The notice above the transcript for a share from a newer format than this viewer reads (see compat.ts). */
import { plural } from "../../src/format.ts";
import type { ReadShare } from "./compat.ts";
import { h } from "./dom.ts";
import { warnIcon } from "./el.ts";

export interface Gaps {
  /** How many placeholders the transcript shows for what it couldn't draw. */
  count: number;
  /** Scrolls to the first of them. */
  goToFirst: () => void;
}

export function renderCompatNotice(formats: NonNullable<ReadShare["newer"]>, gaps: Gaps): HTMLElement {
  return h(
    "div",
    { class: "compat-notice", role: "status" },
    warnIcon(),
    h(
      "div",
      {},
      h("p", { class: "compat-title" }, "Shared with a newer agent-share"),
      h(
        "p",
        {},
        "Format ",
        h("code", {}, formats.shared),
        "; this viewer reads ",
        h("code", {}, formats.viewer),
        ". ",
        gaps.count ? h("strong", {}, plural(gaps.count, "part")) : null,
        gaps.count ? " can't be shown." : "Parts of it may be missing.",
      ),
      gaps.count ? h("button", { type: "button", class: "compat-go", onclick: gaps.goToFirst }, gaps.count === 1 ? "Jump to it ↓" : "Jump to the first ↓") : null,
    ),
  );
}
