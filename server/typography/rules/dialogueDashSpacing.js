// server/typography/rules/dialogueDashSpacing.js

// server/typography/rules/dialogueDashSpacing.js

export function dialogueDashSpacing(html) {
  if (!html) return html;

  let out = html;

  // APERTURA DIALOGO:
  // <p>-Ehi  -> <p>- Ehi
  // \n-Ehi   -> \n- Ehi
  out = out.replace(/(<p>\s*)-(?=\S)/gi, "$1- ");
  out = out.replace(/([\n\r])-(?=\S)/g, "$1- ");

  // CHIUSURA DIALOGO:
  // "?- le"  -> "? - le"
  // "…- sussurra" -> "… - sussurra"
  out = out.replace(/([.!?…])\s*-\s*(?=\S)/gu, "$1 - ");

  // Pulizia doppi spazi
  out = out.replace(/ -  /g, " - ");

  return out;
}

