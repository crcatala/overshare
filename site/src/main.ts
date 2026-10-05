/**
 * Landing page behavior: the nav border on scroll, one-shot reveals (the receipt printing,
 * the screenshot rising, the tickets, the redaction sweep), the share-mode switcher with its
 * size ledger, and the copy buttons. Everything renders without JS; the reveals only start
 * hidden once this has run.
 */
document.documentElement.classList.add("js");

const nav = document.getElementById("nav")!;
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

// One-shot reveals: anything marked [data-reveal] gets `.in` the first time it scrolls into view.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const reveals = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
if (reduce || !("IntersectionObserver" in window)) {
  for (const el of reveals) el.classList.add("in");
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
  );
  for (const el of reveals) io.observe(el);
}

// Share modes. Sizes are the example session's share file in each mode (`exampleShare({ mode })`; tests/site.vitest.ts checks them).
type Mode = "full" | "brief" | "minimal" | "prompts";
const MODES: Record<Mode, { title: string; text: string; kb: number }> = {
  full: { title: "Full", text: "Everything after redaction: prompts, replies, thinking, every tool call with its input and output (each cut at 20k characters).", kb: 51.9 },
  brief: { title: "Brief", text: "Prompts and replies. Consecutive tool calls collapse into groups with the files and commands involved. No tool output. The default for publish.", kb: 17.8 },
  minimal: { title: "Minimal", text: "Prompts, the final reply of each turn, and per-turn tool counts.", kb: 16.5 },
  prompts: { title: "Prompts", text: "Only what you typed, followed by a compact activity line per turn. No replies, filenames, commands or tool output.", kb: 8.5 },
};
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".seg button")];
const rows = [...document.querySelectorAll<HTMLButtonElement>("[data-kb-row]")];
const thumb = document.querySelector<HTMLElement>(".seg .thumb")!;
const selected = () => tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0]!;
function moveThumb(tab: HTMLElement): void {
  thumb.style.width = `${tab.offsetWidth}px`;
  thumb.style.transform = `translateX(${tab.offsetLeft}px)`;
}
function setMode(mode: Mode, first = false): void {
  for (const t of tabs) {
    const on = t.dataset.mode === mode;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) moveThumb(t);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-show]")) {
    const show = el.dataset.show!.split(" ").includes(mode);
    el.hidden = !show;
    if (show && !first) {
      el.classList.remove("swap");
      void el.offsetWidth; // restart the fade-in
      el.classList.add("swap");
    }
  }
  for (const row of rows) {
    const on = row.dataset.kbRow === mode;
    row.classList.toggle("on", on);
    row.setAttribute("aria-pressed", String(on));
  }
  const { title, text, kb } = MODES[mode];
  document.getElementById("mi-title")!.textContent = title;
  document.getElementById("mi-text")!.textContent = text;
  document.getElementById("mi-size")!.textContent = `${kb} KB`;
}
// The ledger bars are drawn from the same numbers as the readout, so they can't drift apart.
for (const row of rows) row.style.setProperty("--w", `${(MODES[row.dataset.kbRow as Mode].kb / MODES.full.kb) * 100}%`);
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode as Mode));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    next.focus();
    setMode(next.dataset.mode as Mode);
  });
});
for (const row of rows) row.addEventListener("click", () => setMode(row.dataset.kbRow as Mode));
setMode("full", true);
addEventListener("resize", () => moveThumb(selected()));
void document.fonts?.ready.then(() => moveThumb(selected()));

// Copy buttons.
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.addEventListener("click", async () => {
    const label = button.querySelector(".t")!;
    try {
      await navigator.clipboard.writeText(button.dataset.copy!);
      label.textContent = "Copied";
      button.classList.add("done");
    } catch {
      label.textContent = "Select to copy";
    }
    setTimeout(() => {
      label.textContent = "Copy";
      button.classList.remove("done");
    }, 1600);
  });
}
