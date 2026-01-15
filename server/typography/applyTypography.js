// server/typography/applyTypography.js

import { dialogueDashSpacing } from "./rules/dialogueDashSpacing.js";

/**
 * Post-processing tipografico deterministico (Fermento).
 * Input/Output: HTML (string).
 */
export function applyTypography(html) {
  let out = html;

  // Regola 1: spazi corretti sui trattini dei dialoghi
  out = dialogueDashSpacing(out);

  return out;
}
