import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import mammoth from "mammoth";
import htmlToDocx from "html-to-docx";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

// Import pdf-parse (CommonJS) da ESM
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

dotenv.config();

// Path per il file di salvataggio valutazioni
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVAL_FILE = path.join(__dirname, "evaluations.json");

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// =========================
//  HELPER: gestione valutazioni su file
// =========================
async function loadEvaluations() {
  try {
    const data = await fs.promises.readFile(EVAL_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    // Se file non esiste o errore lettura → mappa vuota
    return {};
  }
}

async function saveEvaluations(map) {
  const json = JSON.stringify(map, null, 2);
  await fs.promises.writeFile(EVAL_FILE, json, "utf-8");
}

function makeProjectKey(title, author) {
  const t = (title || "").trim().toLowerCase();
  const a = (author || "").trim().toLowerCase();
  return `${t}||${a}`;
}

async function storeEvaluation(projectTitle, projectAuthor, evaluationHtml) {
  const all = await loadEvaluations();
  const key = makeProjectKey(projectTitle, projectAuthor);

  all[key] = {
    title: projectTitle || "",
    author: projectAuthor || "",
    evaluationHtml: evaluationHtml || "",
    updatedAt: new Date().toISOString(),
  };

  await saveEvaluations(all);
}

async function getEvaluation(projectTitle, projectAuthor) {
  const all = await loadEvaluations();
  const key = makeProjectKey(projectTitle, projectAuthor);
  return all[key] || null;
}

// Lista dei progetti salvati (per elenco progetti)
async function listProjects() {
  const all = await loadEvaluations();
  return Object.values(all).map((item) => ({
    title: item.title || "",
    author: item.author || "",
    updatedAt: item.updatedAt || null,
  }));
}

// =========================
//  HELPER: HTML → testo semplice (per PDF)
// =========================
function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  let text = html;

  // Rimpiazza alcuni tag blocco con a capo
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");

  // Rimuovi tutti i tag HTML rimanenti
  text = text.replace(/<[^>]+>/g, "");

  // Normalizza spazi
  text = text.replace(/\r/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");

  return text.trim();
}

// =========================
//  FUNZIONE PROMPT AI
// =========================
function buildPrompt(text, mode, editorialContext) {
  const context =
    editorialContext && editorialContext.trim()
      ? `
---
CONTESTO EDITORIALE DA TENERE PRESENTE

Di seguito trovi la valutazione editoriale e la raccomandazione sull'opera.
Usale come guida per le scelte di editing (tono, ritmo, ritmo narrativo,
chiarezza, target, punti di forza da valorizzare, criticità da attenuare):

${editorialContext}

FINE CONTESTO EDITORIALE.
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

${context}

Ora esegui l'editing del testo seguente tenendo conto del contesto editoriale (soprattutto la raccomandazione editoriale), ma senza alterare contenuti, personaggi, eventi e struttura di base.

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
- Limitati a VALUTARE E COMMENTARE.
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
//  /api/upload-docx (DOCX + PDF)
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
    const isDocx = name.endsWith(".docx");
    const isPdf = name.endsWith(".pdf");

    if (!isDocx && !isPdf) {
      return res.status(400).json({
        success: false,
        error: "Sono accettati solo file .docx (Word) o .pdf.",
      });
    }

    console.log("Upload file ricevuto:", req.file.originalname);

    // ---- DOCX ----
    if (isDocx) {
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
    }

    // ---- PDF ----
    if (isPdf) {
      const data = await pdf(req.file.buffer);
      let text = data.text || "";

      const paragraphs = text
        .split(/\n\s*\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const html = paragraphs
        .map((p) => {
          const escaped = p
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `<p>${escaped}</p>`;
        })
        .join("\n\n");

      return res.json({
        success: true,
        text: html,
      });
    }
  } catch (err) {
    console.error("Errore /api/upload-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante la lettura del file (.docx o .pdf)",
    });
  }
});

// =========================
//  /api/ai
// =========================
app.post("/api/ai", async (req, res) => {
  try {
    console.log("Richiesta /api/ai ricevuta.");
    const { text, mode, editorialContext, projectTitle, projectAuthor } =
      req.body || {};

    console.log("Mode:", mode);
    console.log("Lunghezza testo:", text ? text.length : 0);
    console.log(
      "Progetto:",
      (projectTitle || "").trim(),
      "/",
      (projectAuthor || "").trim()
    );

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Campo 'text' mancante o non valido",
      });
    }

    const prompt = buildPrompt(
      text,
      mode || "correzione",
      editorialContext || ""
    );

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

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() || "";

    console.log("Risposta OpenAI ricevuta, lunghezza:", aiText.length);

    // Se è una valutazione manoscritto, salviamo su file (se abbiamo progetto)
    if (mode === "valutazione-manoscritto") {
      if (
        (projectTitle && projectTitle.trim()) ||
        (projectAuthor && projectAuthor.trim())
      ) {
        try {
          await storeEvaluation(projectTitle || "", projectAuthor || "", aiText);
          console.log("Valutazione salvata per il progetto.");
        } catch (saveErr) {
          console.error("Errore durante il salvataggio valutazione:", saveErr);
        }
      } else {
        console.log(
          "Valutazione manoscritto senza titolo/autore: non viene salvata su file."
        );
      }
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
//  /api/load-evaluation
// =========================
app.post("/api/load-evaluation", async (req, res) => {
  try {
    const { projectTitle, projectAuthor } = req.body || {};

    if (
      (!projectTitle || !projectTitle.trim()) &&
      (!projectAuthor || !projectAuthor.trim())
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Per caricare una valutazione è necessario indicare almeno il titolo del progetto (meglio titolo + autore).",
      });
    }

    const evalData = await getEvaluation(projectTitle || "", projectAuthor || "");

    if (!evalData) {
      return res.status(404).json({
        success: false,
        error:
          "Nessuna valutazione salvata trovata per questo progetto (controlla titolo e autore).",
      });
    }

    return res.json({
      success: true,
      evaluationHtml: evalData.evaluationHtml || "",
      title: evalData.title || "",
      author: evalData.author || "",
      updatedAt: evalData.updatedAt || null,
    });
  } catch (err) {
    console.error("Errore /api/load-evaluation:", err);
    return res.status(500).json({
      success: false,
      error: "Errore interno durante il caricamento della valutazione.",
    });
  }
});

// =========================
//  /api/projects – elenco progetti salvati
// =========================
app.get("/api/projects", async (req, res) => {
  try {
    const projects = await listProjects();

    // Ordina per updatedAt decrescente
    projects.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });

    return res.json({
      success: true,
      projects,
    });
  } catch (err) {
    console.error("Errore /api/projects:", err);
    return res.status(500).json({
      success: false,
      error: "Errore interno durante il caricamento dell'elenco progetti.",
    });
  }
});

// =========================
//  /api/download-docx – genera DOCX da qualsiasi HTML
// =========================
app.post("/api/download-docx", async (req, res) => {
  try {
    const { correctedHtml, filename } = req.body || {};

    if (!correctedHtml || typeof correctedHtml !== "string") {
      return res.status(400).json({ error: "Missing correctedHtml" });
    }

    const safeFilename =
      (filename && filename.trim()) || "testo-corretto.docx";

    let htmlBody = enhanceHeadings(correctedHtml);

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
//  /api/download-eval-pdf – PDF solo valutazione
// =========================
app.post("/api/download-eval-pdf", async (req, res) => {
  try {
    const { evaluationHtml, filename } = req.body || {};

    if (!evaluationHtml || typeof evaluationHtml !== "string") {
      return res.status(400).json({ error: "Missing evaluationHtml" });
    }

    const baseName =
      (filename && filename.trim()) || "valutazione-manoscritto.pdf";
    const safeFilename = baseName.endsWith(".pdf")
      ? baseName
      : baseName + ".pdf";

    const plainText = htmlToPlainText(evaluationHtml);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`
    );

    const doc = new PDFDocument({
      margin: 50,
      size: "A4",
    });

    doc.pipe(res);
    doc.fontSize(12).text(plainText, {
      align: "left",
    });
    doc.end();
  } catch (err) {
    console.error("Errore /api/download-eval-pdf:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Errore nella generazione del PDF" });
    }
  }
});

// =========================
//  AVVIO SERVER
// =========================
app.listen(port, () => {
  console.log(`Fermento AI backend in ascolto su http://localhost:${port}`);
});
