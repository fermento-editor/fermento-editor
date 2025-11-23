import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import mammoth from "mammoth";
import htmlToDocx from "html-to-docx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// =========================
//  FILE VALUTAZIONI
// =========================
const EVAL_FILE = path.join(__dirname, "evaluations.json");

function loadEvaluations() {
  try {
    if (!fs.existsSync(EVAL_FILE)) return [];
    const raw = fs.readFileSync(EVAL_FILE, "utf8");
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("Errore lettura evaluations.json:", err);
    return [];
  }
}

function saveEvaluations(list) {
  try {
    fs.writeFileSync(EVAL_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("Errore scrittura evaluations.json:", err);
  }
}

function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html.replace(/<[^>]+>/g, " ");
}

function extractRecommendationSummary(html) {
  if (!html || typeof html !== "string") return "";

  const lower = html.toLowerCase();
  const marker = "<h3>8. raccomandazione editoriale</h3>";
  let summary = "";

  const idx = lower.indexOf(marker);
  if (idx !== -1) {
    const after = html.slice(idx + marker.length);
    const nextH3 = after.toLowerCase().indexOf("<h3>");
    const block = nextH3 !== -1 ? after.slice(0, nextH3) : after;
    summary = stripHtml(block).replace(/\s+/g, " ").trim();
  } else {
    // fallback: tutto l'html "ripulito"
    summary = stripHtml(html).replace(/\s+/g, " ").trim();
  }

  if (summary.length > 300) summary = summary.slice(0, 300) + "...";
  return summary;
}

// =========================
//  FUNZIONE PROMPT AI
// =========================
function buildPrompt(text, mode, extraOptions = {}) {
  const { evaluationGuidance } = extraOptions || {};

  const guidanceBlock = evaluationGuidance
    ? `
LINEE GUIDA EDITORIALI SPECIFICHE PER QUESTO MANOSCRITTO:
${evaluationGuidance}

Devi seguire queste indicazioni mentre fai l'editing del testo.
`
    : "";

  // 1) Correzione testo = SOLO refusi evidenti, niente stile
  if (mode === "correzione" || mode === "correzione-soft") {
    return `
Sei un correttore di bozze esperto per una casa editrice italiana (Fermento).

OBIETTIVO (CORREZIONE TESTO):
- Restituire lo STESSO testo ricevuto, ma con corretti soltanto i refusi evidenti:
  - errori di battitura
  - accenti
  - apostrofi
  - lettere mancanti/doppie
  - spaziature e segni di punteggiatura palesemente sbagliati.

REGOLE FERREE:
- NON riscrivere frasi.
- NON migliorare lo stile.
- NON modernizzare il linguaggio.
- NON cambiare il lessico, a meno che sia chiaramente un errore di battitura.
- NON cambiare il contenuto, gli eventi, i dialoghi o i personaggi.
- NON aggiungere né togliere frasi.
- NON aggiungere commenti, note o spiegazioni.
- Mantieni il più possibile identici a capo, paragrafi e struttura.
- Il testo può contenere tag HTML (come <p>, <em>, <strong>): mantieni TUTTI i tag intatti, limitandoti a correggere il testo all'interno.

Se hai il dubbio che qualcosa possa essere una scelta stilistica, LASCIA COM'È.

Restituisci SOLO il testo corretto, nello stesso formato (HTML incluso se presente), senza alcuna spiegazione.

TESTO DA CORREGGERE (può contenere HTML):

${text}
`;
  }

  // 2) Editing = riscrittura moderna, ma fedele nei contenuti
  if (mode === "editing" || mode === "editing-profondo") {
    return `
Sei un editor professionista per la casa editrice Fermento.

${guidanceBlock}

OBIETTIVO (EDITING):
Prendi il testo del romanzo che segue e riscrivilo come se fosse
una traduzione completamente nuova e contemporanea, facendo sì che la lettura
risulti naturale e moderna, con queste caratteristiche:

- Frasi fluide e scorrevoli, ritmo narrativo più contemporaneo, transizioni chiare tra le scene.
- Vocabolario attuale, evitando termini arcaici o troppo desueti, senza banalizzare il tono.
- Dialoghi naturali, con un linguaggio che sembri quello di oggi, rispettando però i personaggi e la loro personalità.
- Descrizioni e narrazione aggiornate nello stile: mantieni TUTTI i dettagli, ma rendili più leggibili e immediati.

DEVI ANCHE:
- Correggere i refusi evidenti (errori di battitura, lettere mancanti o doppie, apostrofi, accenti, punteggiatura).

NON DEVI:
- Aggiungere o inventare contenuti, eventi o dettagli non presenti nell’originale.
- Cambiare nomi, fatti, personaggi o ambientazioni.
- Alterare il significato delle frasi.
- Sintetizzare, riassumere, accorciare o tagliare il testo.
- Aggiungere commenti, note o spiegazioni.

STRUTTURA:
- Mantieni la stessa successione dei paragrafi e dei capitoli.
- Se nel testo sono presenti tag HTML (<p>, <em>, <strong>...), mantienili e restituisci il risultato sempre in HTML coerente,
  aggiornando solo il contenuto testuale all'interno.

Restituisci il testo COMPLETO, come una versione nuova, moderna e scorrevole,
fedele nella sostanza ma aggiornata nello stile, senza nessun commento esterno.

TESTO DA EDITARE (può contenere HTML):

${text}
`;
  }

  // 3) Traduzioni varie (mantieni eventuale HTML)
  if (mode === "traduzione-it-en") {
    return `
Traduci in inglese naturale e scorrevole il seguente testo italiano.
Mantieni il tono (letterario / commerciale). Il testo può contenere tag HTML (<p>, <em>, <strong>...):
mantieni i tag e traduci solo il contenuto testuale.

Restituisci solo il testo tradotto in inglese, nello stesso formato (HTML incluso), senza commenti o note.

Testo:

${text}
`;
  }

  if (mode === "traduzione-en-it") {
    return `
Traduci in italiano naturale e scorrevole il seguente testo inglese.
Mantieni il tono (letterario / commerciale). Il testo può contenere tag HTML (<p>, <em>, <strong>...):
mantieni i tag e traduci solo il contenuto testuale.

Restituisci solo il testo tradotto in italiano, nello stesso formato (HTML incluso), senza commenti o note.

Testo:

${text}
`;
  }

  if (mode === "traduzione-fr-it") {
    return `
Traduci in italiano naturale e scorrevole il seguente testo francese.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in italiano, nello stesso formato.

Testo:

${text}
`;
  }

  if (mode === "traduzione-es-it") {
    return `
Traduci in italiano naturale e scorrevole il seguente testo spagnolo.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in italiano, nello stesso formato.

Testo:

${text}
`;
  }

  if (mode === "traduzione-de-it") {
    return `
Traduci in italiano naturale e scorrevole il seguente testo tedesco.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in italiano, nello stesso formato.

Testo:

${text}
`;
  }

  if (mode === "traduzione-it-es") {
    return `
Traduci in spagnolo naturale e scorrevole il seguente testo italiano.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in spagnolo, nello stesso formato.

Testo:

${text}
`;
  }

  if (mode === "traduzione-it-fr") {
    return `
Traduci in francese naturale e scorrevole il seguente testo italiano.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in francese, nello stesso formato.

Testo:

${text}
`;
  }

  if (mode === "traduzione-it-de") {
    return `
Traduci in tedesco naturale e scorrevole il seguente testo italiano.
Mantieni tono e registro; mantieni eventuali tag HTML e traduci solo il testo interno.

Restituisci solo il testo tradotto in tedesco, nello stesso formato.

Testo:

${text}
`;
  }

  // 4) Valutazione manoscritto
  if (mode === "valutazione-manoscritto") {
    return `
Sei un editor senior e responsabile scouting per una casa editrice italiana (Fermento).

OBIETTIVO:
Valutare il manoscritto che segue dal punto di vista:
- letterario (stile, voce, costruzione frasi),
- narrativo (trama, ritmo, gestione delle informazioni),
- personaggi (profondità, credibilità, arco di trasformazione),
- originalità,
- potenziale commerciale sul mercato italiano attuale, con particolare attenzione
  ai titoli più venduti in Italia nell'ultimo anno (circa top 20) come riferimento generico
  per tono, ritmo e leggibilità.

IMPORTANTE:
- NON riscrivere il testo.
- NON correggere il testo.
- NON modernizzare né riformulare.
- Limitati a VALUTARE e COMMENTARE.
- Puoi però citare brevi frasi/parole a titolo di esempio.

STRUTTURA DELLA RISPOSTA (in HTML semplice):

<h3>1. Genere e target</h3>
- Individua il genere o ibrido di generi.
- Indica il target principale (es. lettori di narrativa letteraria, romance, giallo commerciale, YA, ecc.).

<h3>2. Stile e voce</h3>
- Commento sulla scrittura (chiarezza, ritmo, registro, coerenza con il genere).
- Punti di forza e debolezza stilistici.

<h3>3. Trama, ritmo e struttura</h3>
- Come funziona l’impianto narrativo in base al testo fornito.
- Ritmo: lento, medio, veloce? Adatto al pubblico di riferimento?

<h3>4. Personaggi</h3>
- Caratterizzazione, coerenza, interesse.
- Eventuali criticità (stereotipi, poca profondità, ecc.).

<h3>5. Originalità e posizionamento</h3>
- Quanto appare originale rispetto ai filoni già saturi.
- Dove potrebbe posizionarsi in libreria (reparto, scaffale).
- A quali tipi di bestseller italiani recenti si avvicina come tono/target (senza esagerare nei paragoni).

<h3>6. Potenziale commerciale</h3>
- Valutazione sintetica del potenziale commerciale per il mercato italiano odierno.
- Punti che aiutano la vendibilità, e possibili ostacoli.

<h3>7. Punteggi sintetici</h3>
- Stile: voto da 1 a 10
- Trama/struttura: voto da 1 a 10
- Personaggi: voto da 1 a 10
- Originalità: voto da 1 a 10
- Potenziale commerciale: voto da 1 a 10

<h3>8. Raccomandazione editoriale</h3>
- Indica sinteticamente una posizione tipo:
  - "Da approfondire con lettura completa"
  - "Interessante ma richiede moltissimo lavoro"
  - "Non in linea con la linea editoriale commerciale attuale"
  - ecc.

LINEE GUIDA:
- Linguaggio professionale ma chiaro, non accademico.
- Non essere cattivo gratuitamente, ma neppure troppo diplomatico: devi essere utile all’editore.
- Basati solo su ciò che è presente nel testo che segue (anche se è solo un estratto).

Restituisci SOLO l’analisi in HTML, senza ripetere il testo del manoscritto.

TESTO DA VALUTARE (può contenere HTML, trattalo come normale testo narrativo):

${text}
`;
  }

  // 5) Fallback generico
  return `
Agisci come correttore ed editor per una casa editrice italiana (Fermento).
Correggi refusi evidenti e migliora leggermente chiarezza e scorrevolezza
SENZA alterare contenuto, stile di base, personaggi, fatti o dialoghi.

Il testo può contenere HTML (<p>, <em>, <strong>...): mantieni tutti i tag, lavora solo sul contenuto testuale.

Restituisci solo il testo lavorato, nello stesso formato.

Testo:

${text}
`;
}

// =========================
//  HELPER: headings capitoli
// =========================
function enhanceHeadings(html) {
  if (!html || typeof html !== "string") return html;

  let firstHeadingSeen = false;

  return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
    const textOnly = inner.replace(/<[^>]+>/g, "").trim().toUpperCase();

    const isLibro =
      textOnly.startsWith("LIBRO ") || textOnly.startsWith("LIBRO&nbsp;");
    const isParte =
      textOnly.startsWith("PARTE ") || textOnly.startsWith("PARTE&nbsp;");
    const isCapitolo =
      textOnly.startsWith("CAPITOLO ") ||
      textOnly.startsWith("CAPITOLO&nbsp;");

    if (!isLibro && !isParte && !isCapitolo) {
      return match;
    }

    let style = "text-align:center; font-weight:bold;";

    if (firstHeadingSeen) {
      style =
        "text-align:center; font-weight:bold; page-break-before:always;";
    }
    firstHeadingSeen = true;

    const level = isLibro ? "h1" : isParte ? "h2" : "h3";
    return `<${level} style="${style}">${inner}</${level}>`;
  });
}

// =========================
//  /api/upload-docx
// =========================
app.post("/api/upload-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Nessun file ricevuto",
      });
    }

    const name = req.file.originalname.toLowerCase();
    if (!name.endsWith(".docx")) {
      return res.status(400).json({
        success: false,
        error: "Sono accettati solo file .docx (Word recente).",
      });
    }

    console.log("Upload .docx ricevuto:", req.file.originalname);

    const result = await mammoth.convertToHtml(
      { buffer: req.file.buffer },
      {
        styleMap: [
          "i => em",
          "b => strong",
          "p[style-name='Normal'] => p:fresh",
        ],
      }
    );

    let html = result.value || "";

    // Normalizza: niente <p> vuoti ridondanti
    html = html.replace(/<p>\s*<\/p>/g, "");

    return res.json({
      success: true,
      text: html,
    });
  } catch (err) {
    console.error("Errore /api/upload-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante la lettura del file .docx",
    });
  }
});

// =========================
//  /api/ai
// =========================
app.post("/api/ai", async (req, res) => {
  try {
    console.log("Richiesta /api/ai ricevuta.");
    const { text, mode, projectTitle, projectAuthor } = req.body || {};

    console.log("Mode:", mode);
    console.log("Lunghezza testo:", text ? text.length : 0);
    console.log(
      "Progetto:",
      (projectTitle || "").trim() || "/",
      "/",
      (projectAuthor || "").trim() || "/"
    );

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Campo 'text' mancante o non valido",
      });
    }

    // Se siamo in editing-profondo, cerchiamo una valutazione collegata
    let evaluationGuidance = "";

    if (mode === "editing-profondo") {
      const allEvals = loadEvaluations();
      const normTitle = (projectTitle || "").trim().toLowerCase();
      const normAuthor = (projectAuthor || "").trim().toLowerCase();

      if (allEvals.length && (normTitle || normAuthor)) {
        const matching = allEvals
          .filter((ev) => {
            const evTitle = (ev.title || "").trim().toLowerCase();
            const evAuthor = (ev.author || "").trim().toLowerCase();

            const titleMatch = normTitle ? evTitle === normTitle : true;
            const authorMatch = normAuthor ? evAuthor === normAuthor : true;

            return titleMatch && authorMatch;
          })
          .sort((a, b) => {
            const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return db - da; // più recente prima
          });

        if (matching.length > 0) {
          const ev = matching[0];
          const recSummary = ev.recommendationSummary || "";
          const plainEval = ev.evaluationHtml
            ? stripHtml(ev.evaluationHtml).replace(/\s+/g, " ").trim()
            : "";

          const trimmedEval =
            plainEval.length > 1500
              ? plainEval.slice(0, 1500) + "..."
              : plainEval;

          evaluationGuidance =
            (recSummary
              ? `Raccomandazione editoriale sintetica: ${recSummary}\n\n`
              : "") +
            (trimmedEval
              ? `Estratto della valutazione editoriale:\n${trimmedEval}`
              : "");
        }
      }
    }

    const prompt = buildPrompt(text, mode || "correzione", {
      evaluationGuidance,
    });

    console.log("Invio richiesta a OpenAI...");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei un assistente specializzato in correzione, editing, traduzione e valutazione manoscritti per la casa editrice Fermento.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const aiText = completion.choices?.[0]?.message?.content?.trim() || "";

    console.log("Risposta OpenAI ricevuta, lunghezza:", aiText.length);

    // Se è una valutazione manoscritto, salviamo su file
    if (mode === "valutazione-manoscritto") {
      const allEvals = loadEvaluations();
      const id = Date.now().toString();
      const createdAt = new Date().toISOString();
      const recommendationSummary = extractRecommendationSummary(aiText);

      const newEval = {
        id,
        title: (projectTitle || "").trim(),
        author: (projectAuthor || "").trim(),
        createdAt,
        recommendationSummary,
        evaluationHtml: aiText,
      };

      allEvals.push(newEval);
      saveEvaluations(allEvals);

      console.log("Valutazione salvata con id:", id);
    }

    return res.json({
      success: true,
      result: aiText,
    });
  } catch (err) {
    console.error("Errore /api/ai:", err);
    let msg = "Errore interno nel server AI";
    if (err.response?.data?.error?.message) {
      msg = err.response.data.error.message;
    } else if (err.message) {
      msg = err.message;
    }

    return res.status(500).json({
      success: false,
      error: msg,
    });
  }
});

// =========================
//  /api/download-docx
// =========================
app.post("/api/download-docx", async (req, res) => {
  try {
    const { correctedHtml, filename } = req.body || {};

    if (!correctedHtml || typeof correctedHtml !== "string") {
      return res.status(400).json({ error: "Missing correctedHtml" });
    }

    const safeFilename =
      (filename && filename.trim()) || "testo-corretto.docx";

    // Migliora headings capitoli
    let htmlBody = enhanceHeadings(correctedHtml);

    // Avvolgiamo in HTML completo
    const fullHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: "Times New Roman", serif;
    font-size: 12pt;
  }
  p {
    margin-top: 0;
    margin-bottom: 0;
    text-align: justify;
  }
</style>
</head>
<body>
${htmlBody}
</body>
</html>
`;

    const buffer = await htmlToDocx(fullHtml, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageSize: "A4",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`
    );

    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Errore /api/download-docx:", err);
    res.status(500).json({ error: "Errore nella generazione del DOCX" });
  }
});

// =========================
//  /api/evaluations (lista)
// =========================
app.get("/api/evaluations", (req, res) => {
  try {
    const allEvals = loadEvaluations();

    const simplified = allEvals
      .map((ev) => ({
        id: ev.id,
        title: ev.title || "",
        author: ev.author || "",
        createdAt: ev.createdAt || "",
        recommendationSummary: ev.recommendationSummary || "",
      }))
      .sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

    res.json({ success: true, evaluations: simplified });
  } catch (err) {
    console.error("Errore /api/evaluations:", err);
    res.status(500).json({
      success: false,
      error: "Errore nel recupero delle valutazioni",
    });
  }
});

// =========================
//  /api/evaluations/:id (dettaglio)
// =========================
app.get("/api/evaluations/:id", (req, res) => {
  try {
    const id = req.params.id;
    const allEvals = loadEvaluations();
    const ev = allEvals.find((e) => e.id === id);

    if (!ev) {
      return res
        .status(404)
        .json({ success: false, error: "Valutazione non trovata" });
    }

    res.json({ success: true, evaluation: ev });
  } catch (err) {
    console.error("Errore /api/evaluations/:id:", err);
    res.status(500).json({
      success: false,
      error: "Errore nel recupero della valutazione",
    });
  }
});

// =========================
//  AVVIO SERVER
// =========================
app.listen(port, () => {
  console.log(`Fermento AI backend in ascolto su http://localhost:${port}`);
});
