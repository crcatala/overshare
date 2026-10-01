/**
 * Transcript text is untrusted: an assistant reply or a tool result can contain raw terminal escape
 * sequences (OSC 52 writes the clipboard, OSC 0 sets the title, CSI 2J clears the screen, …). Anything
 * from a transcript that the browser prints goes through `stripControls` first.
 */
const OSC = String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)`;
const STRING_SEQUENCE = String.raw`\x1b[PX^_][^\x1b]*(?:\x1b\\|$)`; // DCS, SOS, PM, APC
const CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]?`;
const OTHER_ESC = String.raw`\x1b[ -/]*[0-~]?`;
const SEQUENCES = new RegExp(`${OSC}|${STRING_SEQUENCE}|${CSI}|${OTHER_ESC}`, "g");
/** C0 controls except tab and newline, DEL, and the C1 range (0x9b is a one-byte CSI). */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function stripControls(text: string): string {
  return text.replace(SEQUENCES, "").replace(CONTROLS, "");
}
