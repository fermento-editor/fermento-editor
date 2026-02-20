// server/typography/applyTypography.js

/**
 * Post-processing tipografico deterministico (Fermento).
 * Input/Output: HTML (string) contenente di norma UN SOLO <p>...</p>.
 *
 * Nota: qui applichiamo SOLO normalizzazioni "safe" e deterministiche,
 * senza interpretazioni creative.
 */
import { normalizeDialoguePunctuation } from "./rules/normalizeDialoguePunctuation.js";
import { dialogueDashSpacing } from "./rules/dialogueDashSpacing.js";

export function applyTypography(html) {
  if (!html) return html;

  let out = String(html);

  // 1) Uniforma i marker di dialogo nei casi non ambigui:
  //    - converte dash iniziali (-, –, —) in caporali «…»
  //    - converte "- … - disse" in "«…» disse"
  //    - rimuove artefatti ".-" a fine paragrafo
  out = normalizeDialoguePunctuation(out);

  // 2) Rete di sicurezza: spaziatura corretta attorno ai trattini rimasti
  //    (idealmente qui resterà pochissimo, ma meglio normalizzare).
  out = dialogueDashSpacing(out);

  return out;
}