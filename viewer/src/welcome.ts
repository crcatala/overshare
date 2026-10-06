/**
 * The start page: what the viewer shows when opened without a share in the link (and
 * there are no local ones to pick). Says what overshare is, opens a pasted link, links
 * the example session every viewer build ships, and shows how to share your own.
 */
import { attribution, REPO_URL } from "./attribution.ts";
import { h, toast } from "./dom.ts";
import { iconButton } from "./header.ts";
import { settingsButton, type SettingsOptions } from "./settings.ts";
import { copy } from "./share.ts";
import { formatHash, parseShareLink, type HashState } from "./source.ts";

/** The example session the viewer build writes next to itself (EXAMPLE_SHARE_PATH in src/fixtures, which is Node-only). */
export const EXAMPLE_HASH = "#url:examples/session.json";
export const SHARE_COMMAND = "npx overshare publish --current";

export interface WelcomeOptions {
  settings: SettingsOptions;
  toggleTheme: () => void;
  /** Open a pasted link; by default by putting it in the address bar's hash. */
  open?: (state: HashState) => void;
}

export function renderWelcome(opts: WelcomeOptions): HTMLElement {
  const open = opts.open ?? ((state) => (location.hash = formatHash(state)));
  const external = (href: string, label: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

  const input = h("input", {
    type: "text",
    id: "welcome-link",
    class: "welcome-input",
    placeholder: "https://gist.github.com/you/1f3c…",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    "aria-describedby": "welcome-hint",
  });
  const hint = h("p", { id: "welcome-hint", class: "fine welcome-hint", "aria-live": "polite" }, "A gist URL, a link to a share, or just owner/gistId.");
  const fail = (text: string) => {
    hint.textContent = text;
    hint.classList.add("is-error");
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };
  input.addEventListener("input", () => {
    if (!input.hasAttribute("aria-invalid")) return;
    input.removeAttribute("aria-invalid");
    hint.classList.remove("is-error");
    hint.textContent = "A gist URL, a link to a share, or just owner/gistId.";
  });
  const form = h(
    "form",
    {
      class: "welcome-open",
      // Never submitted: the page's CSP has form-action 'none', and the share goes in the hash.
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (!input.value.trim()) return fail("Paste a link first.");
        const state = parseShareLink(input.value);
        if (!state) return fail("That isn't a link to a share. Try a gist URL or owner/gistId.");
        open(state);
      },
    },
    h("label", { for: "welcome-link", class: "welcome-label" }, "Open a shared session"),
    h("div", { class: "welcome-row" }, input, h("button", { type: "submit", class: "welcome-btn" }, "Open")),
    hint,
  );

  const command = h("code", {}, SHARE_COMMAND);
  const copyButton = h(
    "button",
    {
      type: "button",
      class: "welcome-copy",
      "aria-label": "Copy command",
      onclick: async () => toast((await copy(SHARE_COMMAND)) ? "Copied command" : "Couldn't copy the command"),
    },
    "copy",
  );

  return h(
    "div",
    { class: "page welcome" },
    h(
      "header",
      { class: "welcome-hdr" },
      h("div", { class: "hdr-top" }, h("h1", { class: "welcome-title" }, "overshare"), h("div", { class: "hdr-actions" }, iconButton("Toggle color theme", "", opts.toggleTheme, "theme"), settingsButton(opts.settings))),
      h("p", { class: "welcome-lede" }, "Read coding-agent sessions (Claude Code, pi) shared as links. Secrets, paths and emails are redacted on the sharer's machine before anything is uploaded."),
    ),
    form,
    h("p", { class: "welcome-example" }, h("a", { href: EXAMPLE_HASH }, "See an example session →")),
    h(
      "section",
      { class: "welcome-share", "aria-labelledby": "welcome-share-title" },
      h("h2", { id: "welcome-share-title" }, "Share your own"),
      h("div", { class: "welcome-cmd" }, h("span", { class: "welcome-prompt", "aria-hidden": "true" }, "$"), command, copyButton),
      h("p", { class: "fine" }, "Run it where you use Claude Code or pi. It shows what will be redacted, asks before uploading, and publishes a secret GitHub gist. ", external(`${REPO_URL}#quick-start`, "Quick start"), "."),
    ),
    h("p", { class: "fine welcome-privacy" }, "The share in a link sits after the #, which browsers never send to this site. Your browser fetches the session straight from where it's stored, usually GitHub."),
    attribution(),
  );
}
