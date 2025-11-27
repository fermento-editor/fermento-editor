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
// file bestseller di riferimento
const bestsellerPath = path.join(__dirname, "data", "bestseller_2025.json");

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
//   UTILITY: LETTURA BESTSELLER
// ===============================

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

// ===============================
//   FILTRO TIPOGRAFICO FERMENTO
// ===============================

function applyTypographicFixes(text) {
  if (!text) return text;
  let t = text;

  // Normalizza "…" → "..."
  t = t.replace(/…/g, "...");

  // Qualsiasi sequenza di 2 o più punti diventa "..."
  t = t.replace(/\.{2,}/g, "...");

  // Rimuove spazi PRIMA della punteggiatura (. , ; : ! ?)
  t = t.replace(/\s+([.,;:!?])/g, "$1");

  // Rimuove spazi DOPO virgolette di apertura (" « “)
  t = t.replace(/(["«“])\s+/g, "$1");

  // Rimuove spazi PRIMA di virgolette di chiusura (" » ” ’)
  // (incluso l'apostrofo, es: " l'opera" → "l'opera")
  t = t.replace(/\s+(["»”'])/g, "$1");

  // Normalizza doppie virgolette consecutive tipo ""testo""
  t = t.replace(/""/g, '"');

  // 🔹 REGOLE SU ? E ! 🔹

  // Rimuove puntini dopo ? o ! (es. "?...", "!.." → "?", "!")
  t = t.replace(/([!?])\.{1,}/g, "$1");

  // Sequenze miste tipo "??", "!!!", "?!?!" → un solo segno (quello finale)
  t = t.replace(/[!?]{2,}/g, (match) => match[match.length - 1]);

  // 🔹 SPAZIO DOPO VIRGOLETTE DI CHIUSURA 🔹
  // ATTENZIONE: qui NON c'è l'apostrofo → "l'opera" resta "l'opera"
  t = t.replace(/(["»”])\s*(?![.,;:!? \n\r])/g, "$1 ");

  // Normalizza spazi multipli → singolo spazio
  t = t.replace(/ {2,}/g, " ");

  return t;
}

// ===============================
//   UPLOAD DOCX/PDF
// ===============================

async function handleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Nessun file caricato",
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // ====== PDF → testo semplice ======
    if (ext === ".pdf") {
      try {
        const buffer = await fsPromises.readFile(req.file.path);

        // Import dinamico di pdf-parse-fixed (più robusto per ambienti diversi)
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

        // pulizia file temporaneo
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

    // ====== DOCX → HTML (mammoth) ======
    if (ext === ".docx") {
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
    }

    // Formato non supportato
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

// Rotte compatibili per l'upload
app.post("/api/import-docx", upload.single("file"), handleUpload);
app.post("/api/import", upload.single("file"), handleUpload);
app.post("/api/upload", upload.single("file"), handleUpload);

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
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="document.docx"'
    );

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
    const {
      text = "",
      mode,
      projectTitle = "",
      projectAuthor = "",
    } = req.body || {};

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
        '- Dopo la chiusura delle virgolette (“ ”, « » o ") ci deve essere SEMPRE uno spazio prima della parola successiva, a meno che subito dopo ci sia un segno di punteggiatura (. , ; : ! ?).',
        "",
        "È VIETATO:",
        "- Commentare.",
        "- Spiegare le correzioni.",
        "- Fare liste.",
        "- Mettere note.",
        "- Introdurre testo aggiuntivo.",
        "",
        "Restituisci ESCLUSIVAMENTE il testo corretto.",
      ].join("\n");

      userMessage = [
        "Correggi il testo seguente:",
        "",
        text,
        "",
        "⚠️ IMPORTANTISSIMO:",
        "RISPONDI SOLO CON IL TESTO CORRETTO.",
        "Nessun commento, nessuna spiegazione, nessuna introduzione, nessuna lista, nessuna frase extra.",
        "Restituisci SOLO il testo corretto, identico nella struttura.",
      ].join("\n");
    }

    // 🌍 TRADUZIONE ITA → ENG
    else if (mode === "traduzione-it-en") {
      systemMessage = [
        "Sei un traduttore professionista dall'italiano all'inglese.",
        "Mantieni il significato e il tono del testo, ma usa un inglese naturale e scorrevole.",
        "Non aggiungere spiegazioni, non commentare, non cambiare il contenuto.",
        "Restituisci SOLO la traduzione inglese.",
      ].join("\n");

      userMessage = [
        "Traduci in inglese il seguente testo italiano:",
        "",
        text,
      ].join("\n");
    }

       // 📑 VALUTAZIONE MANOSCRITTO – MODELLO FERMENTO (con cinema/serie TV + bestseller + ranking + grammatica)
    else if (mode === "valutazione-manoscritto") {
      // Carica elenco bestseller dal file JSON
      const bestsellers = await loadBestsellers();
      const bestsellersJson = JSON.stringify(bestsellers, null, 2);

      systemMessage = [
        "Sei un editor professionale che valuta manoscritti per una casa editrice italiana.",
        "Devi scrivere una scheda di valutazione EDITORIALE completa, in HTML pulito.",
        "La valutazione serve all'editore, NON all'autore: sii chiaro, professionale, concreto.",
        "",
        "Di seguito trovi un elenco JSON di libri molto venduti e rappresentativi del mercato editoriale italiano recente (2023–2025).",
        "Ogni voce contiene: titolo, autore, genere, temi, stile e target di lettori.",
        "Usa questo elenco COME RIFERIMENTO per la sezione 12 (Analisi comparativa con i bestseller italiani 2025).",
        "",
        bestsellersJson,
        "",
        "FORMATTO OBBLIGATORIO (usa ESATTAMENTE queste sezioni e questi tag HTML):",
        "",
        "<h2>Valutazione editoriale – Fermento</h2>",
        "",
        "<h3>1. Dati di base</h3>",
        "<p><strong>Titolo:</strong> [titolo del progetto]</p>",
        "<p><strong>Autore:</strong> [autore del progetto]</p>",
        "",
        "<h3>2. Sintesi del manoscritto</h3>",
        "<p>Fornisci un riassunto breve, chiaro e oggettivo della storia, senza esprimere giudizi.</p>",
        "",
        "<h3>3. Punti di forza</h3>",
        "<ul>",
        "<li>…</li>",
        "</ul>",
        "",
        "<h3>4. Criticità principali</h3>",
        "<ul>",
        "<li>…</li>",
        "</ul>",
        "",
        "<h3>5. Stile e voce narrativa</h3>",
        "<p>Descrivi lo stile dell’autore, la chiarezza, il ritmo, la musicalità della frase, eventuali problemi di leggibilità, e il tipo di voce narrativa utilizzata.</p>",
        "",
        "<h3>6. Struttura e ritmo</h3>",
        "<p>Analizza l’andamento della storia, la divisione in capitoli, la gestione dei tempi morti, dei colpi di scena e delle accelerazioni narrative.</p>",
        "",
        "<h3>7. Personaggi</h3>",
        "<p>Valuta la credibilità, l’evoluzione, la funzione narrativa e la capacità empatica dei personaggi principali e secondari.</p>",
        "",
        "<h3>8. Target e posizionamento</h3>",
        "<p>Indica il pubblico ideale (età, interessi) e il genere editoriale di riferimento. Spiega in quale segmento di mercato si colloca il manoscritto.</p>",
        "",
        "<h3>9. Possibilità di adattamento per cinema e serie TV</h3>",
        "<p>Valuta se la storia si presta meglio a un film, una miniserie o una serie lunga, motivando la scelta.</p>",
        "<p>Commenta cosa facilita l’adattamento (mondo narrativo, dialoghi, archi dei personaggi, struttura episodica) e cosa lo ostacola (eccesso di interiorità, costi produttivi alti, mancanza di conflitto visivo).</p>",
        "<p>Concludi con un giudizio sintetico sulla reale possibilità di sviluppo audiovisivo.</p>",
        "",
        "<h3>10. Potenziale commerciale</h3>",
        "<p>Giudizio sintetico sul potenziale economico del libro, considerando trend, titoli comparabili e interesse del pubblico contemporaneo.</p>",
        "",
        "<h3>11. Giudizio finale</h3>",
        "<p><strong>Valutazione complessiva:</strong> fornisci un paragrafo conclusivo su pubblicabilità e condizioni necessarie per un’eventuale edizione.</p>",
        "<p><strong>Punteggio:</strong> X/10</p>",
        "",
        "<h3>12. Analisi comparativa con i bestseller italiani (2025)</h3>",
        "<p>Confronta il manoscritto con i bestseller italiani presenti nell'elenco JSON fornito sopra.</p>",
        "<ul>",
        "<li>Indica a quali bestseller si avvicina e perché (genere, tono, temi, target, struttura).</li>",
        "<li>Identifica i 3 titoli più simili.</li>",
        "<li>Assegna un livello di similarità complessivo 0–100.</li>",
        "<li>Evidenzia cosa manca al manoscritto per avvicinarsi ai titoli top di mercato.</li>",
        "</ul>",
        "",
        "<h3>13. Ranking editoriale Fermento</h3>",
        "<p><strong>Punteggio totale (0–100):</strong> calcolalo secondo questi criteri:</p>",
        "<ul>",
        "<li><strong>Potenziale commerciale:</strong> 0–25</li>",
        "<li><strong>Possibilità di adattamento TV/cinema:</strong> 0–20</li>",
        "<li><strong>Forza narrativa (stile, voce, struttura):</strong> 0–25</li>",
        "<li><strong>Coerenza di target e posizionamento:</strong> 0–10</li>",
        "<li><strong>Somiglianza con i bestseller italiani 2025:</strong> 0–10</li>",
        "<li><strong>Qualità grammaticale e ortografica:</strong> 0–10</li>",
        "</ul>",
        "<p><strong>Livello di priorità:</strong> scegli una delle seguenti categorie:</p>",
        "<ul>",
        "<li><strong>Alta priorità:</strong> punteggio ≥ 75</li>",
        "<li><strong>Media priorità:</strong> 50–74</li>",
        "<li><strong>Bassa priorità:</strong> ≤ 49</li>",
        "</ul>",
        "<p>Inserisci una motivazione sintetica (massimo 4 righe) che giustifichi la categoria assegnata, considerando l’equilibrio tra qualità narrativa, potenziale commerciale, somiglianza col mercato attuale e qualità grammaticale.</p>",
        "",
        "<h3>14. Analisi grammaticale e ortografica</h3>",
        "<p>Valuta il livello di correttezza linguistica del manoscritto: ortografia, grammatica, sintassi, punteggiatura e coerenza tipografica. Indica se il testo necessita di un intervento minimo, moderato o significativo di correzione di bozze e quali sono le aree più problematiche (refusi frequenti, punteggiatura incoerente, accordi verbali, uso scorretto delle maiuscole o delle virgolette, ecc.). Non fornire esempi testuali, ma valuta in modo complessivo il carico di lavoro richiesto per ripulire il testo.</p>",
        "",
        "REGOLE IMPORTANTI:",
        "- Scrivi SEMPRE in italiano.",
        "- RESTITUISCI SOLO HTML NUDO: nessun markdown, nessun ``` e nessun blocco di codice.",
        "- Compila TUTTE le sezioni dall’1 alla 14.",
        "- Usa SOLO questi tag HTML: <h2>, <h3>, <p>, <ul>, <li>, <strong>.",
        "- Non rivolgerti mai direttamente all’autore.",
        "- Non aggiungere testo fuori dalla scheda."
      ].join("\n");

      userMessage = [
        "Crea una scheda di valutazione editoriale per il seguente manoscritto.",
        projectTitle ? `Titolo del progetto: ${projectTitle}` : "",
        projectAuthor ? `Autore del progetto: ${projectAuthor}` : "",
        "",
        "Testo del manoscritto:",
        text
      ].join("\n");
    }

    // fallback di sicurezza
    if (!userMessage) {
      userMessage = text;
    }

    // 🔗 Chiamata a OpenAI (chat completions)
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
