// server/index.js - versione pulita Fermento

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
import { fileURLToPath } from "url";

dotenv.config();

// ===============================
//   PATH E CONFIGURAZIONI BASE
// ===============================

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// __dirname per ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cartella upload
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

// file valutazioni
const evaluationsPath = path.join(__dirname, "data", "evaluations.json");

// ===============================
//   UTILITY: LETTURA/SCRITTURA VALUTAZIONI
// ===============================

async function loadEvaluations() {
  try {
    const data = await fsPromises.readFile(evaluationsPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    // Se non esiste il file, restituiamo lista vuota
    if (err.code === "ENOENT") return [];
    console.error("Errore loadEvaluations:", err);
    return [];
  }
}

async function saveEvaluations(list) {
  try {
    await fsPromises.mkdir(path.dirname(evaluationsPath), { recursive: true });
    await fsPromises.writeFile(
      evaluationsPath,
      JSON.stringify(list, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Errore saveEvaluations:", err);
  }
}

// ===============================
//   FILTRO TIPOGRAFICO FERMENTO
// ===============================

function applyTypographicFixes(text) {
  if (!text) return text;
  let t = text;

  // Normalizza il carattere unico "…" in tre punti "..."
  t = t.replace(/…/g, "...");

  // Qualsiasi sequenza di 2 o più punti diventa esattamente "..."
  t = t.replace(/\.{2,}/g, "...");

  // Rimuove spazi PRIMA della punteggiatura (. , ; : ! ?)
  t = t.replace(/\s+([.,;:!?])/g, "$1");

  // Rimuove spazi DOPO virgolette di apertura (" « “)
  t = t.replace(/(["«“])\s+/g, "$1");

  // Rimuove spazi PRIMA di virgolette di chiusura (" » ”)
  t = t.replace(/\s+(["»”])/g, "$1");

  // Normalizza doppie virgolette consecutive tipo ""testo""
  t = t.replace(/""/g, '"');

  return t;
}

// ===============================
//   IMPORT DOCX (NO PDF) -> HTML
// ===============================
//
// NB: assicurati che il frontend chiami QUESTO endpoint
//     con form-data: { file: <docx> }

app.post("/api/import-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Nessun file caricato",
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    if (ext === ".pdf") {
      // Non gestiamo i PDF: messaggio chiaro per l'editor
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

    if (ext !== ".docx") {
      return res.status(400).json({
        success: false,
        error: "Formato non supportato. Carica un file .docx",
      });
    }

    const buffer = await fsPromises.readFile(req.file.path);
    const result = await mammoth.convertToHtml({ buffer });
    const html = result.value || "";

    // pulizia file temporaneo
    await fsPromises.unlink(req.file.path).catch(() => {});

    return res.json({
      success: true,
      type: "docx",
      text: html,
    });
  } catch (err) {
    console.error("Errore /api/import-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante l'import del DOCX",
    });
  }
});

// ===============================
//   EXPORT HTML -> DOCX
// ===============================
//
// NB: se il frontend usa questa funzionalità, deve chiamare
//     /api/export-docx con body JSON { html: "<p>...</p>" }

app.post("/api/export-docx", async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) {
      return res.status(400).json({
        success: false,
        error: "html mancante nel body",
      });
    }

    const docxBuffer = await htmlToDocx(html, null, {});

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="document.docx"');

    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore /api/export-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante la conversione in DOCX",
    });
  }
});

// ===============================
//   API AI PRINCIPALE
// ===============================

app.post("/api/ai", async (req, res) => {
  try {
    const { mode, text, project, projectTitle, projectAuthor } = req.body;

    console.log("Richiesta /api/ai ricevuta.");
    console.log("Mode:", mode);
    console.log("Lunghezza testo:", text ? text.length : 0);
    console.log("Progetto:", project);
    console.log("Titolo:", projectTitle);
    console.log("Autore:", projectAuthor);

    if (!text || !mode) {
      return res.status(400).json({
        success: false,
        error: "text e mode sono obbligatori.",
      });
    }

    let systemMessage = "";
    let userMessage = "";

       // 🎯 MODALITÀ CORREZIONE (FERMENTO)
    if (mode === "correzione") {
      systemMessage = `
Sei un correttore di bozze editoriale professionista per una casa editrice italiana.

DEVI:
- Correggere SOLO refusi, errori di battitura, punteggiatura, spazi, maiuscole/minuscole e accenti.
- NON cambiare stile, registro, ritmo, lessico o contenuto.
- NON riscrivere, NON semplificare, NON spiegare, NON commentare.
- NON aggiungere alcuna frase, mai.
- Mantenere identici paragrafi, a capo e struttura.

REGOLE TIPOGRAFICHE FERMENTO:
- I puntini di sospensione devono essere SEMPRE esattamente tre: "...".
- Converti qualunque altra forma ("..", "....", "…..", "…") in "...".
- Non introdurre puntini nuovi dove non ci sono.
- Mantieni il tipo di virgolette usato nel testo di partenza.
- Nessuno spazio subito dopo l’apertura delle virgolette ("Ciao", «Ciao»).
- Nessuno spazio subito prima della chiusura delle virgolette ("Ciao", «Ciao»).
- Nessuno spazio prima di punteggiatura (. , ; : ! ?).

È VIETATO:
- Commentare.
- Spiegare le correzioni.
- Fare liste.
- Mettere note.
- Introdurre testo aggiuntivo.

Restituisci ESCLUSIVAMENTE il testo corretto.
`;

      userMessage = `
Correggi il testo seguente:

${text}

⚠️ IMPORTANTISSIMO:
RISPONDI SOLO CON IL TESTO CORRETTO.
Nessun commento, nessuna spiegazione, nessuna introduzione, nessuna lista, nessuna frase extra.
Restituisci SOLO il testo corretto, identico nella struttura.
`;
    }


    // 🌍 MODALITÀ TRADUZIONE IT → EN
    else if (mode === "traduzione-it-en") {
      systemMessage = `
Sei un traduttore professionista dall'italiano all'inglese.
Traduci in un inglese naturale e corretto, mantenendo struttura, paragrafi e formattazione del testo originale.
Non aggiungere commenti, non spiegare nulla, restituisci solo il testo tradotto.
`;

      userMessage = `
Traduci in inglese il seguente testo italiano:

${text}
`;
    }

    // Puoi aggiungere qui altre modalità (valutazione-manoscritto, ecc.)
    else if (mode === "valutazione-manoscritto") {
      systemMessage = `
Sei un editor professionale che valuta manoscritti per una casa editrice italiana.
Scrivi una valutazione dettagliata, in HTML, del manoscritto fornito.
`;
      userMessage = `
Valuta il seguente testo (manoscritto) e produci una scheda di valutazione in HTML:

${text}
`;
    }

    if (!userMessage) {
      userMessage = text;
    }

    // Client OpenAI locale alla route
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        {
          role: "system",
          content: systemMessage || "",
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const aiText =
      response.output?.[0]?.content?.[0]?.text ||
      "Errore: nessun testo generato.";

    // Filtriamo tipograficamente
    const fixedText = applyTypographicFixes(aiText);

    console.log("Risposta OpenAI ricevuta, lunghezza:", fixedText.length);

    // Se è una valutazione, salviamo in evaluations.json
    if (mode === "valutazione-manoscritto") {
      const evaluations = await loadEvaluations();

      const newEval = {
        id: Date.now().toString(),
        title: projectTitle || "Titolo mancante",
        author: projectAuthor || "Autore mancante",
        date: new Date().toISOString(),
        html: fixedText,
      };

      evaluations.push(newEval);
      await saveEvaluations(evaluations);

      return res.json({
        success: true,
        result: fixedText,
        savedId: newEval.id,
      });
    }

    // Altri mode: restituiamo solo il testo AI corretto tipograficamente
    return res.json({
      success: true,
      result: fixedText,
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
