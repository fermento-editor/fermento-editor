/* ============================================================
   server/index.js - Fermento Editor backend (DOCX + PDF + AI)
   Versione completa e pulita — BLOCCO 1/4
   ============================================================ */

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

/* ===============================
   PATH BASE + CARTELLE
   =============================== */
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cartella upload
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// File valutazioni
const evaluationsPath = path.join(__dirname, "data", "evaluations.json");

// File bestseller
const bestsellerPath = path.join(__dirname, "data", "bestseller_2025.json");

/* ===============================
   CLIENT OPENAI
   =============================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("OPENAI_API_KEY presente?", !!process.env.OPENAI_API_KEY);

/* ===============================
   FUNZIONE EDITING BLOCCHI (HTML-SAFE)
   =============================== */
async function callOpenAIForEditing(htmlBlock, mode) {
  let modeInstruction;

  if (mode === "leggero") {
    modeInstruction =
      "Fai un editing LEGGERO: correggi refusi, punteggiatura, concordanze e piccole imperfezioni senza alterare lo stile.";
  } else if (mode === "moderato") {
    modeInstruction =
      "Fai un editing MODERATO: migliora leggermente la scorrevolezza senza modificare la voce dell'autore.";
  } else if (mode === "profondo") {
    modeInstruction =
      "Fai un editing PROFONDO: rendi fluide frasi rigide mantenendo i contenuti invariati.";
  } else {
    modeInstruction =
      "Correggi refusi e punteggiatura mantenendo identico stile e contenuti.";
  }

  const systemMessage =
    "Sei un editor professionale Fermento. Lavora SOLO sul testo interno ai tag HTML. NON modificare tag, attributi, ordine o struttura. Restituisci solo l'HTML pulito.";

  const userMessage =
    modeInstruction +
    "\n\nEcco il BLOCCO HTML da editare. Rispondi SOLO con l'HTML:\n\n" +
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
/* ===============================
   SPLIT IN BLOCCHI
   =============================== */
function splitIntoBlocks(text, maxChars = 15000) {
  const blocks = [];
  let remaining = text || "";

  if (!remaining.trim()) return blocks;

  while (remaining.length > maxChars) {
    let cutoff = maxChars;

    while (cutoff > 0 && remaining[cutoff] !== " ") {
      cutoff--;
    }

    if (cutoff === 0) cutoff = maxChars;

    blocks.push(remaining.slice(0, cutoff).trim());
    remaining = remaining.slice(cutoff).trim();
  }

  if (remaining.length > 0) {
    blocks.push(remaining);
  }

  return blocks;
}

/* ===============================
   FILTRO TIPOGRAFICO FERMENTO
   =============================== */
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

/* ===============================
   LETTURA/SCRITTURA VALUTAZIONI
   =============================== */
async function loadEvaluations() {
  try {
    const data = await fsPromises.readFile(evaluationsPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
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

/* ===============================
   LETTURA BESTSELLER
   =============================== */
async function loadBestsellers() {
  try {
    const data = await fsPromises.readFile(bestsellerPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn("bestseller_2025.json non trovato, uso lista vuota.");
      return [];
    }
    console.error("Errore loadBestsellers:", err);
    return [];
  }
}

/* ===============================
   EXPRESS APP
   =============================== */
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Multer upload
const upload = multer({ dest: uploadDir });

/* ===============================
   UPLOAD DOCX / PDF
   =============================== */
async function handleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Nessun file caricato",
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // ===== PDF =====
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

        if (!pdfParseFn) {
          throw new Error("Modulo pdf-parse-fixed non compatibile");
        }

        const result = await pdfParseFn(buffer);
        const text = result.text || "";

        await fsPromises.unlink(req.file.path).catch(() => {});

        return res.json({
          success: true,
          type: "pdf",
          text,
        });
      } catch (err) {
        console.error("Errore parsing PDF:", err);
        await fsPromises.unlink(req.file.path).catch(() => {});
        return res.status(500).json({
          success: false,
          error: "Errore nella lettura del PDF",
        });
      }
    }

    // ===== DOCX =====
    if (ext === ".docx") {
      const buffer = await fsPromises.readFile(req.file.path);
      const result = await mammoth.convertToHtml({ buffer });
      const html = result.value || "";

      await fsPromises.unlink(req.file.path).catch(() => {});

      return res.json({
        success: true,
        type: "docx",
        text: html,
      });
    }

    await fsPromises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({
      success: false,
      error: "Formato non supportato. Carica un file .docx o .pdf",
    });
  } catch (err) {
    console.error("Errore upload DOCX/PDF:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante l'import del file",
    });
  }
}

app.post("/api/import-docx", upload.single("file"), handleUpload);
app.post("/api/import", upload.single("file"), handleUpload);
app.post("/api/upload", upload.single("file"), handleUpload);

/* ===============================
   API VALUTAZIONI
   =============================== */
app.post("/api/evaluations", async (req, res) => {
  try {
    const { projectId, fileName, title, evaluationText, meta } = req.body;

    if (!evaluationText) {
      return res.status(400).json({ error: "evaluationText mancante" });
    }

    const all = await loadEvaluations();

    const newEval = {
      id: Date.now().toString(),
      projectId: projectId || null,
      fileName: fileName || null,
      title: title || fileName || "Valutazione senza titolo",
      evaluationText,
      meta: meta || {},
      createdAt: new Date().toISOString(),
    };

    all.push(newEval);
    await saveEvaluations(all);

    res.json({
      success: true,
      evaluation: newEval,
    });
  } catch (err) {
    console.error("Errore /api/evaluations POST:", err);
    res.status(500).json({ error: "Errore salvataggio valutazione" });
  }
});

app.get("/api/evaluations", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const { projectId } = req.query;
    const filtered = projectId
      ? list.filter((v) => v.projectId === projectId)
      : list;

    return res.json({
      success: true,
      evaluations: filtered,
    });
  } catch (err) {
    console.error("Errore GET /api/evaluations:", err);
    return res.status(500).json({
      success: false,
      error: "Errore lettura valutazioni",
    });
  }
});

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

app.delete("/api/evaluations/:id", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const remaining = list.filter((v) => v.id !== req.params.id);

    if (remaining.length === list.length) {
      return res.status(404).json({
        success: false,
        error: "Valutazione non trovata",
      });
    }

    await saveEvaluations(remaining);

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error("Errore DELETE /api/evaluations/:id:", err);
    return res.status(500).json({
      success: false,
      error: "Errore cancellazione valutazione",
    });
  }
});
/* ===============================
   EDITING LIBRO INTERO (HTML SAFE)
   =============================== */
app.post("/api/edit-full-book", async (req, res) => {
  try {
    const { text, mode } = req.body;

    console.log("📥 /api/edit-full-book chiamato");
    console.log("   Mode:", mode);
    console.log("   Lunghezza testo:", text ? text.length : 0);

    if (!text || typeof text !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "Testo mancante o non valido." });
    }

    if (!mode) {
      return res
        .status(400)
        .json({ ok: false, error: "Mode mancante (leggero/moderato/profondo)." });
    }

    const blocks = splitIntoBlocks(text, 15000);
    console.log("   Numero blocchi:", blocks.length);

    const editedBlocks = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      console.log(
        `   Editing blocco ${i + 1}/${blocks.length}, lunghezza: ${block.length}`
      );

      const edited = await callOpenAIForEditing(block, mode);
      editedBlocks.push(edited);
    }

    const fullEditedText = editedBlocks.join("\n\n");

    return res.json({
      ok: true,
      blocksCount: blocks.length,
      editedBlocks,
      fullEditedText,
    });
  } catch (err) {
    console.error("Errore in /api/edit-full-book:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Errore interno nel full book editing." });
  }
});

/* ===============================
   EXPORT HTML → DOCX
   =============================== */
app.post("/api/export-docx", async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) {
      return res.status(400).json({
        success: false,
        error: "html mancante nel body",
      });
    }

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

    const buffer = await htmlToDocx(fullHtml, null, {});

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="fermento-document.docx"'
    );

    return res.end(buffer);
  } catch (err) {
    console.error("Errore /api/export-docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante la conversione in DOCX",
    });
  }
});

/* ===============================
   API AI — SEMPLIFICATA, SENZA VALUTAZIONE OBBLIGATORIA
   =============================== */
app.post("/api/ai", async (req, res) => {
  try {
    const {
      text = "",
      mode,
      projectTitle = "",
      projectAuthor = "",
    } = req.body || {};

    if (!mode) {
      return res.status(400).json({
        success: false,
        error: "Parametro mode mancante.",
      });
    }

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Parametro text mancante o vuoto.",
      });
    }

    let systemMessage = "";
    let userMessage = "";

    /* ===========================
       CORREZIONE FERMENTO
       =========================== */
    if (mode === "correzione" || mode === "correzione-soft") {
      systemMessage = [
        "Sei un correttore di bozze editoriale professionista.",
        "Devi correggere SOLO refusi, punteggiatura, accenti e maiuscole.",
        "Niente cambi di stile, niente riscritture, niente commenti.",
        "Restituisci esclusivamente il testo corretto.",
      ].join("\n");

      userMessage = text;
    }

    /* ===========================
       TRADUZIONE ITA → ENG
       =========================== */
    else if (mode === "traduzione-it-en") {
      systemMessage = [
        "Sei un traduttore professionale ITA → ENG.",
        "Traduce in inglese mantenendo tono e significato.",
        "Non aggiungere nulla. Non commentare.",
      ].join("\n");

      userMessage = text;
    }

    /* ===========================
       EDITING (senza valutazione)
       =========================== */
    else if (
      mode === "editing-leggero" ||
      mode === "editing-moderato" ||
      mode === "editing-profondo"
    ) {
      let profile = "";

      if (mode === "editing-leggero") {
        profile = "Editing leggero: correggi grammatica e punteggiatura.";
      } else if (mode === "editing-moderato") {
        profile =
          "Editing moderato: migliora ritmo e chiarezza ma mantieni lo stile.";
      } else {
        profile =
          "Editing profondo: riscrivi frasi dure o poco chiare mantenendo contenuto e significato.";
      }

      systemMessage = [
        "Sei un editor professionista Fermento.",
        profile,
        "Non aggiungere contenuti, non introdurre idee nuove.",
        "Restituisci solo il testo editato.",
      ].join("\n");

      userMessage = text;
    }

    /* ===========================
       VALUTAZIONE MANOSCRITTO
       =========================== */
    else if (mode === "valutazione-manoscritto") {
      systemMessage = [
        "Sei un valutatore professionale di manoscritti.",
        "Produci una valutazione strutturata in sezioni.",
        "Scrivi in modo chiaro, diretto e commerciale.",
      ].join("\n");

      userMessage = [
        projectTitle ? `Titolo: ${projectTitle}` : "",
        projectAuthor ? `Autore: ${projectAuthor}` : "",
        "",
        text,
      ].join("\n");
    }

    else {
      return res.status(400).json({
        success: false,
        error: `Modalità sconosciuta: ${mode}`,
      });
    }

    /* ===============================
       Chiamata OpenAI
       =============================== */
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Errore: nessun testo generato.";

    const fixedText = applyTypographicFixes(aiText);

    return res.json({
      success: true,
      result: fixedText,
    });
  } catch (err) {
    console.error("Errore /api/ai:", err);

    return res.status(500).json({
      success: false,
      error: err.message || "Errore interno nel server AI.",
    });
  }
});

/* ===============================
   AVVIO SERVER
   =============================== */
app.listen(PORT, () => {
  console.log(`Fermento AI backend in ascolto su http://localhost:${PORT}`);
});
