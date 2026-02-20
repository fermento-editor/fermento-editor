// server/typography/rules/normalizeDialoguePunctuation.js
//
// Normalizzazione deterministica dei marker di dialogo.
// Obiettivo: uniformare i casi NON ambigui.
// Standard target: dialogo in caporali «…».
// - Converte paragrafi "dialogo puro" che iniziano con -, – o — in «…»
// - Converte pattern "- … - disse ..." in "«…» disse ..."
// - Rimuove artefatti tipo ".-" a fine paragrafo
//
// Input/Output: HTML con singolo <p>...</p> (di norma).

export function normalizeDialoguePunctuation(html) {
  if (!html) return html;
  let out = String(html);

  // 0) Sanifica: rimuovi ".-" a fine paragrafo/riga (artefatto tipo "Maddie.-")
  // <p>Testo.-</p> -> <p>Testo.</p>
  out = out.replace(/(\.)\s*-\s*(<\/p>\s*$)/giu, "$1$2");

  // 1) Pattern: apertura dash + chiusura dash prima dell'inciso
  // <p>-Testo… - disse lui.</p> -> <p>«Testo…» disse lui.</p>
  // Supporta -, – e —
  out = out.replace(
    /<p>(\s*)([-–—])\s*([\s\S]*?)([.!?…])\s*[-–—]\s+(?=\S)([\s\S]*?)<\/p>/giu,
    (_m, lead, _dash, speech, punct, after) => {
      const s = String(speech || "").trim();
      const a = String(after || "").trim();
      if (!s || !a) return _m;

      // Se già ci sono caporali nel parlato, non toccare
      if (s.includes("«") || s.includes("»")) return _m;

      return `<p>${lead}«${s}${punct}» ${a}</p>`;
    }
  );

  // 2) Paragrafo "dialogo puro" che inizia con dash (- – —)
  // <p>—Ciao.</p> -> <p>«Ciao.»</p>
  // Nota: non tocca paragrafi che contengono già caporali.
  out = out.replace(
    /<p>(\s*)([-–—])\s*(?!<\/p>)([\s\S]*?)<\/p>/giu,
    (_m, lead, _dash, body) => {
      const b = String(body || "").trim();
      if (!b) return _m;

      // Se già caporali, non toccare
      if (b.includes("«") || b.includes("»")) return _m;

      // Se contiene il pattern da inciso (gestito sopra), non toccare qui
      // (evita doppie trasformazioni)
      if (b.match(/(^|[.!?…])\s*[-–—]\s+\S/iu)) return _m;

      return `<p>${lead}«${b}»</p>`;
    }
  );

  return out;
}