// ===============================
//   FERMENTO EDITOR - BACKEND
//   Versione stabile (DOCX + valutazioni)
//   (PDF momentaneamente disattivato)
// ===============================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import mammoth from "mammoth";
import htmlToDocx from "html-to-docx";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Upload in memoria
const upload = multer({ storage: multer.memoryStorage() });

// Client OpenAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ===============================
//   Gestione file dati valutazioni
// ===============================
const __dirnameResolved = path.resolve();
const DATA_DIR = path.join(__dirnameResolved, "server", "data");
const EVAL_FILE = path.join(DATA_DIR, "evaluations.json");

async function ensureDataFiles() {
  try {
    await fsPromises.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("Errore creazione cartella data:", err);
  }

  try {
    await fsPromises.access(EVAL_FILE, fs.constants.F_OK);
  } catch {
    await fsPromises.writeFile(EVAL_FILE, "[]", "utf8");
    console.log("Creato evaluations.json");
  }
}

await ensureDataFiles();

async function loadEvaluations() {
  try {
    const raw = await fsPromises.readFile(EVAL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Errore lettura evaluations.json:", err);
    return [];
  }
}

async function saveEvaluations(list) {
  try {
    await fsPromises.writeFile(EVAL_FILE, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Errore scrittura evaluations.json:", err);
    return false;
  }
}

// ===============================
//   Costruzione prompt
// ===============================
function buildPrompt(text, mode) {
  if (mode === "correzione" || mode === "correzione-soft") {
    return `
Sei un correttore di bozze per la casa editrice Fermento.

OBIETTIVO:
- Correggere SOLO refusi evidenti (battitura, accenti, apostrofi, punteggiatura palesemente errata).
- NON cambiare stile, tono, lessico, contenuto.
- Mantieni intatti eventuali tag HTML (<p>, <em>, <strong>, ecc.).

RESTITUISCI:
- SOLO il testo corretto, senza spiegazioni.

TESTO:
${text}
`;
  }

  if (mode === "editing" || mode === "editing-profondo") {
    return `
Sei un editor professionista per la casa editrice Fermento.

OBIETTIVO:
- Riscrivere il testo in uno stile moderno, fluido e naturale.
- Mantenere TUTTI i contenuti, eventi, personaggi, dialoghi e informazioni.
- Migliorare leggibilità, ritmo e chiarezza.
- NON riassumere, NON tagliare, NON aggiungere contenuti.
- Correggere anche i refusi evidenti.

Se sono presenti tag HTML, mantienili (es. <p>, <em>, <strong>), modificando solo il testo interno.

RESTITUISCI:
- Il testo completo riscritto in stile moderno.

TESTO:
${text}
`;
  }

  if (mode === "valutazione-manoscritto") {
    return `
Sei un editor senior e responsabile scouting della casa editrice Fermento.

Fornisci una VALUTAZIONE EDITORIALE strutturata in HTML seguendo questo schema:

<h3>1. Genere e target</h3>
- Individua genere/i e pubblico ideale.

<h3>2. Stile e voce narrativa</h3>
- Commenta qualità della scrittura, ritmo, chiarezza.

<h3>3. Struttura narrativa</h3>
- Commenta impostazione, gestione del ritmo, equilibrio tra scene.

<h3>4. Personaggi</h3>
- Profondità, coerenza, interesse, evoluzione (per quanto si può capire dal testo).

<h3>5. Punti di forza</h3>
- Elenca ciò che funziona meglio, anche dal punto di vista commerciale.

<h3>6. Debolezze</h3>
- Evidenzia criticità (stilistiche, strutturali, di mercato).

<h3>7. Potenziale commerciale</h3>
- Valuta possibilità di successo sul mercato italiano contemporaneo.

<h3>8. Raccomandazione editoriale</h3>
- Indica una raccomandazione sintetica (es. "Da approfondire", "Interessante ma richiede molto lavoro", "Poco adatto alla nostra linea", ecc.).

NON riscrivere il testo, NON correggerlo, NON modificarlo. Limitati ad analizzare e commentare.

TESTO DA VALUTARE:
${text}
`;
  }

  // fallback leggero
  return `
Sei un correttore leggero per Fermento. Correggi refusi evidenti mantenendo lo stile e l'HTML:

TESTO:
${text}
`;
}

// ===============================
//   Migliora heading per DOCX
// ===============================
function enhanceHeadings(html) {
  if (!html || typeof html !== "string") return html;

  let firstSeen = false;

  return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
    const clean = inner.replace(/<[^>]+>/g, "").trim().toUpperCase();

    const isLibro = clean.startsWith("LIBRO ");
    const isParte = clean.startsWith("PARTE ");
    const isCapitolo = clean.startsWith("CAPITOLO ");

    if (!isLibro && !isParte && !isCapitolo) return match;

    let style = "text-align:center; font-weight:bold;";
    if (firstSeen) {
      style += " page-break-before:always;";
    }
    firstSeen = true;

    const tag = isLibro ? "h1" : isParte ? "h2" : "h3";
    return `<${tag} style="${style}">${inner}</${tag}>`;
  });
}

// ===============================
//   Upload DOCX (PDF momentaneamente non supportato)
// ===============================
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

    console.log("Upload ricevuto:", req.file.originalname);

    if (isPdf) {
      // PDF NON supportato, ma rispondiamo con 200
      // così il frontend mostra il messaggio in modo leggibile
      return res.json({
        success: false,
        error:
          "Al momento il server NON supporta direttamente i PDF.\n\n" +
          "Per usarlo in Fermento Editor:\n" +
          "1) Apri il PDF in Word o LibreOffice\n" +
          "2) Salvalo come file .docx\n" +
          "3) Carica il .docx nell'app.",
      });
    }


    if (!isDocx) {
      return res.status(400).json({
        success: false,
        error: "Sono supportati solo file .docx (Word).",
      });
    }

    // DOCX → HTML
    const result = await mammoth.convertToHtml(
      { buffer: req.file.buffer },
      {
        styleMap: ["i => em", "b => strong"],
      }
    );

    let html = result.value || "";
    html = html.replace(/<p>\s*<\/p>/g, ""); // rimuove p vuoti

    return res.json({
      success: true,
      type: "docx",
      text: html,
    });
  } catch (err) {
    console.error("Errore /api/upload-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante il caricamento del file",
    });
  }
});

// ===============================
//   Download DOCX
// ===============================
app.post("/api/download-docx", async (req, res) => {
  try {
    const { correctedHtml, filename } = req.body || {};

    if (!correctedHtml || typeof correctedHtml !== "string") {
      return res.status(400).json({ error: "Missing correctedHtml" });
    }

    const safeName = (filename && filename.trim()) || "testo-fermento.docx";

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
      pageSize: "A4",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}"`
    );

    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Errore /api/download-docx:", err);
    res.status(500).json({ error: "Errore nella generazione del DOCX" });
  }
});

// ===============================
//   /api/ai → correzione, editing, valutazione
// ===============================
app.post("/api/ai", async (req, res) => {
  try {
    const { text, mode, projectTitle, projectAuthor } = req.body || {};

    console.log("Richiesta /api/ai ricevuta.");
    console.log("Mode:", mode);
    console.log("Lunghezza testo:", text ? text.length : 0);
    console.log("Progetto:", projectTitle, "/", projectAuthor, "/");

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Campo 'text' mancante o non valido",
      });
    }

    const prompt = buildPrompt(text, mode || "correzione");

    console.log("Invio richiesta a OpenAI...");

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei un assistente specializzato in correzione, editing, valutazione per la casa editrice Fermento.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const aiText = completion.choices?.[0]?.message?.content?.trim() || "";
    console.log("Risposta OpenAI ricevuta, lunghezza:", aiText.length);

    // Se è una valutazione, salviamo in evaluations.json
    if (mode === "valutazione-manoscritto") {
      const evaluations = await loadEvaluations();

      const newEval = {
        id: Date.now().toString(),
        title: projectTitle || "Titolo mancante",
        author: projectAuthor || "Autore mancante",
        date: new Date().toISOString(),
        html: aiText,
      };

      evaluations.push(newEval);
      await saveEvaluations(evaluations);

      return res.json({
        success: true,
        result: aiText,
        savedId: newEval.id,
      });
    }

    // Altri mode: restituiamo solo il testo AI
    return res.json({
      success: true,
      result: aiText,
    });
  } catch (err) {
    console.error("Errore /api/ai:", err);
    let msg = "Errore interno nel server AI";
    if (err.response?.data?.error?.message) msg = err.response.data.error.message;
    else if (err.message) msg = err.message;

    return res.status(500).json({
      success: false,
      error: msg,
    });
  }
});

// ===============================
//   GET lista valutazioni
// ===============================
app.get("/api/evaluations", async (req, res) => {
  try {
    const list = await loadEvaluations();
    return res.json({
      success: true,
      evaluations: list,
    });
  } catch (err) {
    console.error("Errore GET /api/evaluations:", err);
    return res.status(500).json({
      success: false,
      error: "Errore lettura valutazioni",
    });
  }
});

// ===============================
//   GET singola valutazione
// ===============================
app.get("/api/evaluations/:id", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const found = list.find((v) => v.id === req.params.id);

    if (!found) {
      return res.status(404).json({
        success: false,
        error: "Valutazione non trovata",
      });
    }

    return res.json({
      success: true,
      evaluation: found,
    });
  } catch (err) {
    console.error("Errore GET /api/evaluations/:id:", err);
    return res.status(500).json({
      success: false,
      error: "Errore lettura valutazione",
    });
  }
});

// ===============================
//   AVVIO SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`Fermento AI backend in ascolto su http://localhost:${PORT}`);
});
