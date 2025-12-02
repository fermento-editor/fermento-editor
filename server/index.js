// server/index.js - Fermento Editor backend (DOCX + PDF + AI)

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
// PATH BASE (__dirname) + FILE DATI
// ===============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cartella upload
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// ===============================
//   CLIENT OPENAI
// ===============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("OPENAI_API_KEY presente?", !!process.env.OPENAI_API_KEY);

// ===============================
//   FUNZIONE DI EDITING SINGGOLO BLOCCO (HTML-SAFE)
// ===============================
async function callOpenAIForEditing(htmlBlock, mode) {
  let modeInstruction;

  if (mode === "leggero") {
    modeInstruction =
      "Fai un editing LEGGERO: correggi refusi, punteggiatura, concordanze e piccole imperfezioni nel TESTO, senza cambiare stile o struttura delle frasi se non è necessario.";
  } else if (mode === "moderato") {
    modeInstruction =
      "Fai un editing MODERATO: oltre alle correzioni, migliora leggermente la scorrevolezza delle frasi quando serve, mantenendo stile e voce dell'autore.";
  } else if (mode === "profondo") {
    modeInstruction =
      "Fai un editing PROFONDO: correggi refusi, punteggiatura e riscrivi le frasi poco chiare o rigide per renderle più fluide, mantenendo invariati contenuti e significato.";
  } else {
    modeInstruction =
      "Correggi refusi, punteggiatura e piccole imperfezioni mantenendo contenuti e stile invariati.";
  }

  const systemMessage =
    "Sei un editor professionale di Fermento. " +
    "Il testo che ti invio è in formato HTML. " +
    "DEVI rispettare tassativamente queste regole:\n" +
    "- Lavora SOLO sul testo visibile agli utenti, NON sui tag HTML.\n" +
    "- NON aggiungere, rimuovere o cambiare il tipo di tag.\n" +
    "- NON modificare attributi.\n" +
    "- Restituisci HTML valido con gli stessi tag, cambiando solo il contenuto testuale.\n";

  const userMessage =
    modeInstruction +
    "\n\n" +
    "Ecco il BLOCCO HTML da editare. " +
    "Restituisci SOLO l'HTML, senza testo esterno:\n\n" +
    htmlBlock;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
  });

  return completion.choices[0].message.content;
}

// ===============================
//   FUNZIONE SPLIT IN BLOCCHI
// ===============================
function splitIntoBlocks(text, maxChars = 15000) {
  const blocks = [];
  let remaining = text || "";

  if (!remaining.trim()) {
    return blocks;
  }

  while (remaining.length > maxChars) {
    let cutoff = maxChars;
    while (cutoff > 0 && remaining[cutoff] !== " ") {
      cutoff--;
    }
    if (cutoff === 0) cutoff = maxChars;

    const block = remaining.slice(0, cutoff).trim();
    if (block.length > 0) blocks.push(block);

    remaining = remaining.slice(cutoff).trim();
  }

  if (remaining.length > 0) blocks.push(remaining);

  return blocks;
}

// ===============================
//   FILTRO TIPOGRAFICO FERMENTO
// ===============================
function applyTypographicFixes(text) {
  if (!text) return text;
  let t = text;

  t = t.replace(/…/g, "...");
  t = t.replace(/\.{2,}/g, "...");
  t = t.replace(/\s+([.,;:!?])/g, "$1");
  t = t.replace(/(["«“])\s+/g, "$1");
  t = t.replace(/\s+(["»”'])/g, "$1");
  t = t.replace(/""/g, '"');
  t = t.replace(/([!?])\.{1,}/g, "$1");
  t = t.replace(/[!?]{2,}/g, (m) => m[m.length - 1]);
  t = t.replace(/(["»”])\s*(?![.,;:!? \n\r])/g, "$1 ");
  t = t.replace(/ {2,}/g, " ");

  return t;
}

// ===============================
//   EXPRESS APP
// ===============================
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// multer per upload
const upload = multer({ dest: uploadDir });

// ===============================
//   UPLOAD DOCX/PDF
// ===============================
async function handleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Nessun file caricato" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // ====== PDF → testo semplice ======
    if (ext === ".pdf") {
      try {
        const buffer = await fsPromises.readFile(req.file.path);

        const pdfModule = await import("pdf-parse-fixed");
        let pdfParseFn = null;

        if (typeof pdfModule.default === "function") {
          pdfParseFn = pdfModule.default;
        } else if (typeof pdfModule === "function") {
          pdfParseFn = pdfModule;
        } else if (typeof pdfModule.pdfParse === "function") {
          pdfParseFn = pdfModule.pdfParse;
        }

        if (!pdfParseFn) throw new Error("Modulo pdf-parse-fixed non compatibile");

        const result = await pdfParseFn(buffer);
        const text = result.text || "";

        await fsPromises.unlink(req.file.path).catch(() => {});

        return res.json({ success: true, type: "pdf", text });
      } catch (err) {
        console.error("Errore PDF:", err);
        await fsPromises.unlink(req.file.path).catch(() => {});
        return res.status(500).json({ success: false, error: "Errore nella lettura del PDF" });
      }
    }

    // ====== DOCX → HTML (mammoth) ======
    if (ext === ".docx") {
      const buffer = await fsPromises.readFile(req.file.path);
      const result = await mammoth.convertToHtml({ buffer });
      const html = result.value || "";

      await fsPromises.unlink(req.file.path).catch(() => {});

      return res.json({ success: true, type: "docx", text: html });
    }

    await fsPromises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({
      success: false,
      error: "Formato non supportato. Carica un file .docx o .pdf",
    });
  } catch (err) {
    console.error("Errore upload DOCX/PDF:", err);
    return res.status(500).json({ success: false, error: "Errore durante l'import del file" });
  }
}

app.post("/api/import-docx", upload.single("file"), handleUpload);
app.post("/api/import", upload.single("file"), handleUpload);
app.post("/api/upload", upload.single("file"), handleUpload);

// ===============================
//   EXPORT HTML -> DOCX
// ===============================
app.post("/api/export-docx", async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ success: false, error: "html mancante" });

    const fullHtml = `
      <html>
        <head>
          <style>
            p { margin: 0; padding: 0; }
            h1, h2, h3 { margin-top: 18pt; margin-bottom: 6pt; }
          </style>
        </head>
        <body>${html}</body>
      </html>
    `;

    const docxBuffer = await htmlToDocx(fullHtml, null, {});

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="fermento-document.docx"');

    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore export DOCX:", err);
    return res.status(500).json({ success: false, error: "Errore durante la conversione in DOCX" });
  }
});

// ===============================
//   API AI PRINCIPALE (SEMPLIFICATA)
// ===============================
app.post("/api/ai", async (req, res) => {
  try {
    const { text = "", mode, projectTitle = "", projectAuthor = "" } = req.body || {};

    if (!mode)
      return res.status(400).json({ success: false, error: "Parametro 'mode' mancante." });

    if (!text || typeof text !== "string" || !text.trim())
      return res.status(400).json({ success: false, error: "Parametro 'text' mancante o vuoto." });

    let systemMessage = "";
    let userMessage = "";

    // =======================
    // MODALITÀ: CORREZIONE
    // =======================
    if (mode === "correzione" || mode === "correzione-soft") {
      systemMessage = [
        "Sei un correttore di bozze professionale.",
        "Correggi SOLO refusi, battitura, punteggiatura, spazi e accenti.",
        "Non cambiare stile o contenuti.",
        "Restituisci SOLO il testo corretto."
      ].join("\n");

      userMessage = text;
    }

    // =======================
    // MODALITÀ: TRADUZIONE IT→EN
    // =======================
    else if (mode === "traduzione-it-en") {
      systemMessage =
        "Sei un traduttore professionista italiano→inglese. Mantieni tono e significato.";

      userMessage = text;
    }

    // =======================
    // MODALITÀ: EDITING (LEGGERO/MODERATO/PROFONDO)
    // =======================
    else if (
      mode === "editing-profondo" ||
      mode === "editing-moderato" ||
      mode === "editing-leggero"
    ) {
      let profile;
      if (mode === "editing-profondo")
        profile =
          "EDITING PROFONDO: migliora stile, chiarezza, fluidità. Puoi riscrivere dove necessario.";
      else if (mode === "editing-moderato")
        profile =
          "EDITING MODERATO: migliora scorrevolezza senza alterare tono o significato.";
      else
        profile =
          "EDITING LEGGERO: correggi punteggiatura e piccoli problemi stilistici.";

      systemMessage = [
        "Sei un editor professionista per una casa editrice.",
        profile,
        "Non cambiare eventi o contenuti.",
        "Restituisci SOLO il testo editato."
      ].join("\n");

      userMessage = text;
    }

    // =======================
    // MODALITÀ: VALUTAZIONE MANOSCRITTO
    // =======================
    else if (mode === "valutazione-manoscritto") {
      systemMessage = [
        "Sei un editor professionale.",
        "Produci una scheda di valutazione completa e onesta.",
        "Dividi in sezioni: Dati di base, Sintesi, Punti di forza, Criticità, Stile, Ritmo, Personaggi, Potenziale commerciale, Giudizio finale."
      ].join("\n");

      userMessage = [
        projectTitle ? `Titolo: ${projectTitle}` : "",
        projectAuthor ? `Autore: ${projectAuthor}` : "",
        "",
        "Testo:",
        text
      ].join("\n");
    }

    // =======================
    //         FALLBACK
    // =======================
    else {
      return res.status(400).json({
        success: false,
        error: `Modalità sconosciuta: ${mode}`,
      });
    }

    // =======================
    // CHIAMATA OPENAI
    // =======================
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Errore: nessun testo generato.";

    const fixed = applyTypographicFixes(aiText);

    return res.json({
      success: true,
      result: fixed,
    });
  } catch (err) {
    console.error("Errore /api/ai:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Errore interno nel server AI",
    });
  }
});

// ===============================
//   AVVIO SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`Fermento AI backend in ascolto su http://localhost:${PORT}`);
});
