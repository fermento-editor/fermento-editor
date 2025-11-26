// server/index.js - versione pulita Fermento + PDF

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
//   CLIENT OPENAI
// ===============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("OPENAI_API_KEY presente?", !!process.env.OPENAI_API_KEY);

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

  // Rimuove spazi PRIMA di virgolette di chiusura (" » ” ’)
  t = t.replace(/\s+(["»”'])/g, "$1");

  // Normalizza doppie virgolette consecutive tipo ""testo""
  t = t.replace(/""/g, '"');

  // 🔹 REGOLE SU ? E ! 🔹

  // 1) Rimuove puntini dopo ? o ! (es. "?...", "!.." -> "?", "!")
  t = t.replace(/([!?])\.{1,}/g, "$1");

  // 2) Qualsiasi sequenza di ? o ! (anche miste) diventa un solo segno,
  // mantenendo SOLO l'ultimo (es. "??" -> "?", "!!!" -> "!", "?!?!" -> "!")
  t = t.replace(/[!?]{2,}/g, (match) => match[match.length - 1]);

  // 🔹 SPAZIO DOPO VIRGOLETTE DI CHIUSURA 🔹
  // Dopo " » ” ’ ci deve essere uno spazio,
  // a meno che subito dopo ci sia già punteggiatura o uno spazio/linea nuova.
  t = t.replace(/(["»”'])\s*(?![.,;:!? \n\r])/g, "$1 ");

  // Normalizza eventuali spazi multipli in singolo spazio
  t = t.replace(/ {2,}/g, " ");

  return t;
}

// ===============================
//   UPLOAD DOCX/PDF (DOCX per correzioni, PDF per valutazioni)
// ===============================

async function handleDocxUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Nessun file caricato",
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // ===============================
    //   PDF → testo semplice → HTML
    // ===============================
    if (ext === ".pdf") {
      try {
        const buffer = await fsPromises.readFile(req.file.path);

        // Import dinamico di pdf-parse v2/v3
        const pdfModule = await import("pdf-parse");
        const { PDFParse } = pdfModule;

        if (!PDFParse) {
          throw new Error("PDFParse non trovato nel modulo pdf-parse");
        }

        // Istanzia il parser (QUI serviva il new)
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        if (parser.destroy) {
          await parser.destroy();
        }

        const txt = result?.text || "";

        // Trasformiamo il testo in HTML a paragrafi (blocchi separati da righe vuote)
        const html = txt
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .map((p) => `<p>${p}</p>`)
          .join("\n");

        // pulizia file temporaneo
        await fsPromises.unlink(req.file.path).catch(() => {});

        return res.json({
          success: true,
          type: "pdf",
          text: html,
        });
      } catch (err) {
        console.error("Errore parsing PDF:", err);
        await fsPromises.unlink(req.file.path).catch(() => {});
        return res.status(500).json({
          success: false,
          error:
            "Errore durante la lettura del PDF. Verifica che il file non sia solo un'immagine scansionata.",
        });
      }
    }

    // ===============================
    //   DOCX → HTML (mammoth)
    // ===============================
    if (ext !== ".docx") {
      return res.status(400).json({
        success: false,
        error: "Formato non supportato. Carica un file .docx o .pdf",
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
    console.error("Errore upload DOCX/PDF:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante l'import del file",
    });
  }
}


// Rotte compatibili per l'upload
app.post("/api/import-docx", upload.single("file"), handleDocxUpload);
app.post("/api/import", upload.single("file"), handleDocxUpload);
app.post("/api/upload", upload.single("file"), handleDocxUpload);

// ===============================
//   EXPORT HTML -> DOCX
// ===============================

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
    const { text = "", mode, projectTitle = "", projectAuthor = "" } = req.body || {};

    let systemMessage = "";
    let userMessage = "";

    // 🎯 CORREZIONE FERMENTO (rigida)
    if (mode === "correzione" || mode === "correzione-soft") {
      systemMessage = [
        "Sei un correttore di bozze editoriale professionista per una casa editrice italiana.",
        "",
        "DEVI:",
        "- Correggere SOLO refusi, errori di battitura, punteggiatura, spazi, maiuscole/minuscole e accenti.",
        "- NON cambiare stile, registro, ritmo, lessico o contenuto.",
        "- NON riscrivere, NON semplificare, NON spiegare, NON commentare.",
        "- NON aggiungere alcuna frase.",
        "- Mantenere identici paragrafi, a capo e struttura.",
        "",
        "REGOLE TIPOGRAFICHE FERMENTO:",
        '- I puntini di sospensione devono essere SEMPRE esattamente tre: "...".',
        '- Converti qualunque altra forma ("..", "....", "…..", "…") in "...".',
        "- Non introdurre puntini nuovi dove non ci sono.",
        "- Mantieni il tipo di virgolette usato nel testo di partenza.",
        '- Nessuno spazio subito dopo l’apertura delle virgolette ("Ciao", «Ciao»).',
        '- Nessuno spazio subito prima della chiusura delle virgolette ("Ciao", «Ciao»).',
        "- Nessuno spazio prima di punteggiatura (. , ; : ! ?).",
        '- Sequenze come "?...", "??...", "?!...", "???", devono diventare sempre "?". Mai lasciare puntini o ripetizioni dopo il punto interrogativo.',
        '- Sequenze come "!...", "!!...", "!?...", "!!!", devono diventare sempre "!". Mai lasciare puntini o ripetizioni dopo il punto esclamativo.',
        "- Alla fine di una frase ci deve essere SEMPRE un solo punto interrogativo o un solo punto esclamativo. Mai usare \"??\", \"?!\", \"!!\" o varianti.",
        '- Dopo la chiusura delle virgolette (“ ”, « » o ") ci deve essere SEMPRE uno spazio prima della parola successiva, a meno che subito dopo ci sia un segno di punteggiatura (. , ; : ! ?).',
        "",
        "È VIETATO:",
        "- Commentare.",
        "- Spiegare le correzioni.",
        "- Fare liste.",
        "- Mettere note.",
        "- Introdurre testo aggiuntivo.",
        "",
        "Restituisci ESCLUSIVAMENTE il testo corretto."
      ].join("\n");

      userMessage = [
        "Correggi il testo seguente:",
        "",
        text,
        "",
        "⚠️ IMPORTANTISSIMO:",
        "RISPONDI SOLO CON IL TESTO CORRETTO.",
        "Nessun commento, nessuna spiegazione, nessuna introduzione, nessuna lista, nessuna frase extra.",
        "Restituisci SOLO il testo corretto, identico nella struttura."
      ].join("\n");
    }

    // 🌍 TRADUZIONE ITA → ENG
    else if (mode === "traduzione-it-en") {
      systemMessage = [
        "Sei un traduttore professionista dall'italiano all'inglese.",
        "Mantieni il significato e il tono del testo, ma usa un inglese naturale e scorrevole.",
        "Non aggiungere spiegazioni, non commentare, non cambiare il contenuto.",
        "Restituisci SOLO la traduzione inglese."
      ].join("\n");

      userMessage = [
        "Traduci in inglese il seguente testo italiano:",
        "",
        text
      ].join("\n");
    }

    // 📑 VALUTAZIONE MANOSCRITTO
    else if (mode === "valutazione-manoscritto") {
      systemMessage = [
        "Sei un editor professionale che valuta manoscritti per una casa editrice italiana.",
        "Devi scrivere una valutazione dettagliata, in HTML, del manoscritto fornito.",
        "La valutazione serve all'editore per decidere se pubblicare il testo."
      ].join("\n");

      userMessage = [
        "Valuta il seguente testo (manoscritto) e produci una scheda di valutazione in HTML:",
        "",
        text
      ].join("\n");
    }

    // fallback di sicurezza
    if (!userMessage) {
      userMessage = text;
    }

        // 🔗 Chiamata a OpenAI (chat completions, compatibile ovunque)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
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
      completion.choices?.[0]?.message?.content?.trim() ||
      "Errore: nessun testo generato.";

    const fixedText = applyTypographicFixes(aiText);



    console.log("Risposta OpenAI ricevuta, lunghezza:", fixedText.length);

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

    return res.json({
      success: true,
      result: fixedText,
    });
  } catch (err) {
    console.error("Errore /api/ai:", err);
    let msg = "Errore interno nel server AI";
    if (err.response?.data?.error?.message)
      msg = err.response.data.error.message;
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
