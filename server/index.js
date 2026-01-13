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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// __dirname per ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cartella upload
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

// file valutazioni
const evaluationsPath = path.join(__dirname, "data", "evaluations.json");

// file lista best seller mercato
const marketTopListPath = path.join(__dirname, "data", "marketTopList.json");

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
//   UTILITY: LISTA TOP BESTSELLER (MERCATO)
// ===============================

async function loadMarketTopList() {
  try {
    const data = await fsPromises.readFile(marketTopListPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Errore loadMarketTopList:", err);
    }
    return [];
  }
}

async function saveMarketTopList(list) {
  try {
    await fsPromises.mkdir(path.dirname(marketTopListPath), {
      recursive: true,
    });
    await fsPromises.writeFile(
      marketTopListPath,
      JSON.stringify(list, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Errore saveMarketTopList:", err);
  }
}

// ===============================
//   FILTRO TIPOGRAFICO FERMENTO
// ===============================

function applyTypographicFixes(text) {
  if (!text) return text;
  let t = text;


  t = t.replace(/\s+([.,;:!?])/g, "$1");
  t = t.replace(/(["«“])\s+/g, "$1");
  t = t.replace(/\s+(["»”'])/g, "$1");
  t = t.replace(/""/g, '"');
  t = t.replace(/([!?])\.{1,}/g, "$1");
  t = t.replace(/[!?]{2,}/g, (m) => m[m.length - 1]);
  t = t.replace(/(["»”])\s*(?![.,;:!? \n\r])/g, "$1 ");
  t = t.replace(/ {2,}/g, " ");
   // Corregge casi come: La valutazione è" discreta → La valutazione è "discreta
  t = t.replace(/([a-zA-ZÀ-ÿ])"(?=[A-Za-zÀ-ÿ])/g, '$1 "');


  return t;
}

// =========================
// FUNZIONE UNICA DI SPEZZETTAMENTO
// =========================
function chunkText(text, chunkSize = 15000) {
  const chunks = [];
  let index = 0;
  while (index < text.length) {
    chunks.push(text.slice(index, index + chunkSize));
    index += chunkSize;
  }
  return chunks;
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

        const pdfModule = await import("pdf-parse-fixed");
        let pdfParseFn =
          typeof pdfModule.default === "function"
            ? pdfModule.default
            : typeof pdfModule === "function"
            ? pdfModule
            : pdfModule.pdfParse;

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

    // ====== DOCX → HTML ======
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

// ===============================
//   EXPORT HTML -> DOCX
// ===============================

// ===============================
//   EXPORT HTML -> DOCX
// ===============================

app.post("/api/export-docx", async (req, res) => {

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "html mancante nel body",
      });
    }

    // 1) Partiamo dall'HTML ricevuto (può essere solo <p>...</p>)
    let safeHtml = html;

    // 2) Mini-pulizia NON distruttiva
    safeHtml = safeHtml
      .replace(/è\"/g, 'è "')
      .replace(/\"/g, '"');

    // 3) WRAP FONDAMENTALE: html-to-docx vuole una pagina HTML completa
    const wrappedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    ${safeHtml}
  </body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, {
      font: "Times New Roman",
      fontSize: 24, // 12 pt
    });

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
//   DOCX PRESERVE (multipart) - alias operativo
// ===============================
// Riceve: FormData con
// - file: DOCX originale
// - html: HTML finale da esportare
app.post("/api/docx/editing-preserve", upload.single("file"), async (req, res) => {
  try {
    const html = req.body?.html;
 

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "html mancante nel body (multipart)",
      });
    }

    // (facoltativo ma utile) qui puoi vedere se il file arriva davvero
    // const originalName = req.file?.originalname;

    // 1) Partiamo dall'HTML ricevuto
    let safeHtml = html;

    // 2) Mini-pulizia NON distruttiva (stessa della export-docx)
    safeHtml = safeHtml
      .replace(/è\"/g, 'è "')
      .replace(/\"/g, '"');

    // 3) WRAP completo per html-to-docx
    const wrappedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    ${safeHtml}
  </body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, {
      font: "Times New Roman",
      fontSize: 24, // 12 pt
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="OUT.docx"'
    );

    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore /api/docx/editing-preserve:", err);
    return res.status(500).json({
      success: false,
      error: "Errore durante la conversione in DOCX (preserve)",
    });
  }
});

// ===========================
//  API VALUTAZIONI (GET / POST / DELETE / DOCX)
// ===========================

// Elenco valutazioni (con eventuale filtro per projectId)
app.get("/api/evaluations", async (req, res) => {
  try {
    const projectId = req.query.projectId || null;
    const list = await loadEvaluations();

    let filtered = list;
    if (projectId) {
      filtered = list.filter(
        (ev) => !ev.projectId || ev.projectId === projectId
      );
    }

    return res.json({
      success: true,
      evaluations: filtered,
    });
  } catch (err) {
    console.error("Errore GET /api/evaluations:", err);
    return res.status(500).json({
      success: false,
      error: "Errore nel caricamento delle valutazioni",
    });
  }
});

// GET singola valutazione
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

// DOWNLOAD VALUTAZIONE COME DOCX
app.get("/api/evaluations/:id/docx", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const found = list.find((v) => v.id === req.params.id);

    if (!found) {
      return res.status(404).json({
        success: false,
        error: "Valutazione non trovata",
      });
    }

    const html = found.html || found.evaluationText || "";

    const docxBuffer = await htmlToDocx(wrappedHtml, null, { font: "Times New Roman", fontSize: 24 });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    const safeTitle = (found.title || "valutazione")
      .replace(/[^a-zA-Z0-9-_ ]/g, "")
      .slice(0, 50);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeTitle || "valutazione"}.docx"`
    );

    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore GET /api/evaluations/:id/docx:", err);
    return res.status(500).json({
      success: false,
      error: "Errore export DOCX valutazione",
    });
  }
});

// Salvataggio valutazione via POST esplicito dal frontend
app.post("/api/evaluations", async (req, res) => {
  try {
    const {
      projectId = null,
      fileName = null,
      title = "Valutazione",
      author = "",
      evaluationText = "",
      meta = {},
    } = req.body;

    const list = await loadEvaluations();

    const newEval = {
      id: Date.now().toString(),
      projectId,
      fileName,
      title,
      author,
      evaluationText,
      html: evaluationText,
      meta,
      date: new Date().toISOString(),
    };

    list.push(newEval);
    await saveEvaluations(list);

    return res.json({
      success: true,
      evaluation: newEval,
    });
  } catch (err) {
    console.error("Errore POST /api/evaluations:", err);
    return res.status(500).json({
      success: false,
      error: "Errore nel salvataggio della valutazione",
    });
  }
});

// Cancellazione valutazione
app.delete("/api/evaluations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const list = await loadEvaluations();

    const newList = list.filter((ev) => ev.id !== id);
    await saveEvaluations(newList);

    return res.json({ success: true });
  } catch (err) {
    console.error("Errore DELETE /api/evaluations/:id:", err);
    return res.status(500).json({
      success: false,
      error: "Errore nella cancellazione della valutazione",
    });
  }
});

// ===============================
//   API AI PRINCIPALE
// ===============================
app.post("/api/ai", async (req, res) => {
  console.log(">>> /api/ai chiamata, mode:", req.body?.mode);

  try {
    const {
      text = "",
      mode,
      projectTitle = "",
      projectAuthor = "",
      projectId = null, // per collegare valutazioni e editing (legacy)
            useEvaluationForEditing = false,
      currentEvaluation = "",
      graphicProfile = "Narrativa contemporanea",
    } = req.body || {};


    let systemMessage = "";
    let userMessage = "";

    // ===============================================
    // VALUTAZIONE MANOSCRITTO SU LIBRO INTERO
    // (spezzettamento + analisi parziali + mega-analisi finale "Fermento")
    // ===============================================
    if (mode === "valutazione" || mode === "valutazione-manoscritto") {
      try {
        // 1) Spezzetta il testo completo in blocchi grandi
        const chunks = chunkText(text, 80000);
        console.log("VALUTAZIONE: numero chunks:", chunks.length);

        const partialAnalyses = [];

        // 2) Analisi parziali per ogni blocco
        for (let i = 0; i < chunks.length; i++) {
          const promptPartial = `
Sezione ${i + 1}/${chunks.length} del manoscritto.

Analizza SOLO questa sezione in modo sintetico e strutturato:

- Riassunto
- Personaggi e loro evoluzione
- Temi e tono
- Punti di forza narrativi
- Debolezze narrative
- Note su lingua e stile (senza riscrivere il testo)

Testo della sezione:
${chunks[i]}
`;

          const p = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            messages: [{ role: "user", content: promptPartial }],
          });

          partialAnalyses.push(
            p.choices?.[0]?.message?.content?.trim() || ""
          );
        }

        // 2bis) Carica la Top 10 bestseller dal file (se disponibile)
        let topListSnippet = "";
        try {
          const topList = await loadMarketTopList();
          if (Array.isArray(topList) && topList.length > 0) {
            topListSnippet = JSON.stringify(topList).slice(0, 15000);
          }
        } catch (err) {
          console.error("Errore nel caricamento Top 10 mercato:", err);
        }

        // 3) Mega analisi finale – versione "spietata" Fermento
        const finalPrompt = `
Sei un editor professionista che lavora per una casa editrice italiana (Fermento).
Devi redigere una scheda di VALUTAZIONE EDITORIALE COMPLETA, RIGOROSA E SPIETATA
basandoti sulle seguenti analisi parziali del manoscritto (inizio, centro, fine
e/o blocchi successivi dell'opera):

${partialAnalyses.join("\n\n--- SEZIONE ---\n\n")}

REGOLE DI ATTEGGIAMENTO (IMPORTANTI):
- La scheda è scritta per l'EDITORE, non per l'autore.
- Devi essere ANALITICO, ONESTO e SEVERO: non edulcorare i giudizi.
- Non usare formule vaghe o rassicuranti se il testo è debole.
- Metti in evidenza TUTTI i limiti che potrebbero rendere il libro non pubblicabile
  o pubblicabile solo con editing pesante.
- Quando il testo è debole, fallo capire chiaramente all'editore.
- NON rivolgerti mai direttamente all'autore.

DATI DI MERCATO (Top 10 narrativa Italia – JSON semplificato):
${topListSnippet}

Usa questi dati di mercato SOLO per arricchire il punto 12 (confronto con il mercato),
citando titoli / autori / tendenze in modo concreto, ma SENZA incollare il JSON nel testo finale.

REGOLE FORMALI:
- Scrivi SEMPRE in italiano.
- RESTITUISCI SOLO HTML NUDO (nessun markdown, nessun blocco \\\`).
- Usa SOLO questi tag HTML: <h2>, <h3>, <p>, <ul>, <li>, <strong>.
- Non inserire note esterne al documento: tutto deve stare dentro i tag HTML.
- Ogni punto dal 1 al 15 deve contenere testo specifico e non può essere lasciato vuoto.
- Il punto 14 è OBBLIGATORIO e deve SEMPRE contenere:
  - almeno un paragrafo discorsivo che analizzi in modo tecnico gli interventi editoriali necessari;
  - una lista puntata <ul><li> con almeno 7 voci concrete.
- Nel punto 14 NON devi mai limitarti a frasi introduttive come “Gli interventi specifici consigliati includono:” senza la lista: la lista è obbligatoria.
- Nel punto 14 non devi mai lasciare testi segnaposto fra parentesi quadre: sostituiscili sempre con contenuti specifici riferiti a questo manoscritto.

STRUTTURA OBBLIGATORIA DELLA SCHEDA (15 PUNTI):

<h2>Valutazione editoriale – Fermento</h2>

<h3>1. Dati di base</h3>
<p><strong>Titolo:</strong> ${projectTitle || "Titolo mancante"}</p>
<p><strong>Autore:</strong> ${projectAuthor || "Autore mancante"}</p>
<p><strong>Genere dichiarato / percepito:</strong> indica con precisione il genere e l'eventuale sottogenere.</p>

<h3>2. Sintesi del manoscritto</h3>
<p>Riassunto chiaro, neutro e completo della storia, che copra in modo equilibrato
inizio, parte centrale e finale. Non limitarti ai primi capitoli.</p>

<h3>3. Genere, tema centrale e sottotemi</h3>
<p>Indica il genere principale e i temi dominanti. Specifica se il testo appare
allineato o fuori fuoco rispetto alle aspettative di quel genere.</p>

<h3>4. Struttura narrativa</h3>
<p>Analizza in modo tecnico la struttura in atti/parti/capitoli, l'uso del punto di vista,
eventuali flashback, salti temporali, buchi logici. Evidenzia i problemi di struttura
se incidono sulla leggibilità o sulla tensione.</p>

<h3>5. Trama, coerenza interna e gestione dei conflitti</h3>
<p>Valuta la solidità della trama, la coerenza logica e la gestione dei conflitti principali.
Se ci sono svolte poco credibili, forzate o troppo deboli, segnalale in modo esplicito.</p>

<h3>6. Personaggi</h3>
<p>Analizza i personaggi principali e quelli secondari: tridimensionalità, evoluzione,
coerenza psicologica, empatia. Se alcuni personaggi sono stereotipati, inutili o poco
credibili, dillo chiaramente.</p>

<h3>7. Dialoghi</h3>
<p>Valuta la naturalezza e la funzione narrativa dei dialoghi. Evidenzia eventuali dialoghi
artificiosi, troppo esplicativi, ridondanti o inutili.</p>

<h3>8. Stile e voce narrativa</h3>
<p>Descrivi tono, lessico, registro, ritmo della frase. Indica se lo stile è maturo,
acerbo, ridondante, troppo piatto, e se la voce narrativa è riconoscibile o anonima.</p>

<h3>9. Valutazione grammaticale e ortografica</h3>
<p>Giudica in modo sintetico ma chiaro: "ottima", "buona", "discreta", "molto da revisionare".
Se sono presenti pattern ricorrenti di errore (punteggiatura, accordi, tempi verbali,
italiano incerto), elencali.</p>

<h3>10. Ritmo, leggibilità e tenuta dell'attenzione</h3>
<p>Commenta il ritmo nelle diverse parti (inizio, centro, finale). Indica se il testo
rallenta troppo, se ha sezioni prolisse o frettolose, se rischia di annoiare il lettore
medio. Sii esplicito nel dire dove il libro "si siede".</p>

<h3>11. Originalità e posizionamento</h3>
<p>Valuta il grado di originalità rispetto al genere e al mercato italiano contemporaneo.
Specifica se il testo appare derivativo, già visto, oppure se introduce elementi
veramente distintivi.</p>

<h3>12. Confronto con il mercato (top 10 narrativa italiana)</h3>
<p>Confronta il manoscritto con i principali bestseller italiani contemporanei, usando i dati
forniti (titoli, autori, sinossi, tendenze). Indica a quali libri o tendenze si avvicina
per tono, target e impostazione, e se può realisticamente competere per qualità,
leggibilità e respiro narrativo.</p>

<h3>13. Potenziale audiovisivo (cinema / serie TV)</h3>
<p>Valuta se la storia si presta meglio a film singolo, miniserie o serie lunga, e se
ha davvero un potenziale audiovisivo. Indica anche gli ostacoli concreti: costi di
produzione, ambientazioni troppo complicate, eccesso di interiorità non visualizzabile.</p>

<h3>14. Interventi editoriali consigliati</h3>
<p>In questa sezione devi proporre interventi editoriali tecnici e specifici da applicare a questo manoscritto (struttura in atti, tagli o accorpamenti di scene, revisione del punto di vista, miglioramento del ritmo, riscrittura di dialoghi deboli, rafforzamento del finale, ecc.). Il testo deve riferirsi in modo concreto a questo manoscritto e non ripetere le istruzioni generiche del prompt.</p>
<ul>
<li>INTERVENTO 1: [sostituisci questo testo con un intervento concreto mirato a struttura, ritmo o conflitti principali del manoscritto].</li>
<li>INTERVENTO 2: [sostituisci questo testo con un intervento concreto sui personaggi principali (arco di trasformazione, motivazioni, coerenza psicologica)].</li>
<li>INTERVENTO 3: [sostituisci questo testo con un intervento concreto sui personaggi secondari e sulle sottotrame inutili o ridondanti].</li>
<li>INTERVENTO 4: [sostituisci questo testo con un intervento concreto sui dialoghi e sulle scene chiave troppo esplicative o deboli].</li>
<li>INTERVENTO 5: [sostituisci questo testo con un intervento concreto sullo stile e sulla voce narrativa (ridondanze, registro, lessico)].</li>
<li>INTERVENTO 6: [sostituisci questo testo con un intervento concreto sulla gestione del tempo narrativo e dei flashback].</li>
<li>INTERVENTO 7: [sostituisci questo testo con un intervento concreto sul finale e sulla coerenza complessiva della storia].</li>
</ul>

<h3>15. Giudizio finale e punteggio</h3>
<p>
<strong>Giudizio di pubblicabilità (OBBLIGATORIO, scegli solo uno):</strong><br/>
- NON PUBBLICABILE<br/>
- PUBBLICABILE SOLO CON EDITING PROFONDO<br/>
- PUBBLICABILE SENZA RISERVE<br/><br/>

<strong>Punteggio tecnico (1–10):</strong> assegna un voto SEVERO e REALISTICO.<br/><br/>

Scrivi un paragrafo finale freddo e diretto che spieghi perché il manoscritto è (o non è)
una scommessa editoriale sensata.
</p>

---
RESTITUISCI SOLO HTML.  
NESSUN ALTRO TESTO.  
NESSUNA INTRODUZIONE.  
NESSUNA NOTA FUORI STRUTTURA.
`;

        const final = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{ role: "user", content: finalPrompt }],
        });

        const finalText =
          final.choices?.[0]?.message?.content?.trim() ||
          "Errore nella valutazione finale.";

        let fixedText = applyTypographicFixes(finalText);

        // ========================================
        // POST-PROCESSING PUNTO 14 (INTERVENTI)
        // ========================================
        try {
          const marker14 = "<h3>14. Interventi editoriali consigliati</h3>";
          const marker15 = "<h3>15. Giudizio finale e punteggio</h3>";

          const idx14 = fixedText.indexOf(marker14);
          const idx15 = fixedText.indexOf(marker15);

          if (idx14 !== -1 && idx15 !== -1 && idx15 > idx14) {
            const before14 = fixedText.slice(0, idx14);
            const after15 = fixedText.slice(idx15);
            const between = fixedText.slice(idx14, idx15);

            const hasList = between.includes("<li>");

            if (!hasList) {
              const replacement = `${marker14}
<p>Per migliorare il manoscritto sono necessari interventi editoriali mirati, di natura strutturale, stilistica e narrativa. Di seguito alcuni interventi tecnici consigliati.</p>
<ul>
<li>Ristrutturare la parte centrale eliminando o accorciando le sezioni ridondanti che rallentano il ritmo.</li>
<li>Rafforzare le motivazioni e l'arco di trasformazione dei personaggi principali nelle scene chiave.</li>
<li>Ridurre o accorpare i personaggi secondari che non hanno una funzione chiara nella trama.</li>
<li>Riscrivere i dialoghi troppo esplicativi, rendendoli più naturali e funzionali al conflitto delle scene.</li>
<li>Semplificare descrizioni e passaggi introspettivi che appesantiscono la lettura senza aggiungere valore.</li>
<li>Controllare la coerenza temporale (flashback, salti di scena) rendendo più chiara la linea del tempo.</li>
<li>Rivedere il finale perché risulti più coerente con il percorso dei personaggi e più incisivo per il lettore.</li>
</ul>
`;

              fixedText = before14 + replacement + after15;
            }
          }
        } catch (e) {
          console.error("Post-processing punto 14 fallito:", e);
        }

        // 4) Salva la valutazione come sempre
        const evaluations = await loadEvaluations();

        const newEval = {
          id: Date.now().toString(),
          projectId: projectId || null,
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
      } catch (err) {
        console.error("Errore valutazione manoscritto:", err);
        return res.status(500).json({
          success: false,
          error: "Errore durante la valutazione del manoscritto.",
        });
      }
    }

    // ===========================
    // SE SERVE LA VALUTAZIONE PER L'EDITING
    // ===========================
    let evaluationSnippet = "";

    if (
      useEvaluationForEditing &&
      currentEvaluation &&
      currentEvaluation.trim().length > 0
    ) {
      evaluationSnippet = currentEvaluation.trim().slice(0, 2000);
      console.log(
        "Uso valutazione fornita dal frontend, length:",
        evaluationSnippet.length
      );
    } else if (useEvaluation && projectId) {
      try {
        const allEvals = await loadEvaluations();
        const projectEvals = allEvals
          .filter((ev) => ev.projectId === projectId)
          .sort(
            (a, b) =>
              new Date(b.date || 0).getTime() -
              new Date(a.date || 0).getTime()
          );

        const lastEval = projectEvals[0];
        if (lastEval) {
          const rawEval = lastEval.html || lastEval.evaluationText || "";
          evaluationSnippet = rawEval.slice(0, 20000);
          console.log(
            "Trovata valutazione per editing (da file), id:",
            lastEval.id,
            "snippet length:",
            evaluationSnippet.length
          );
        } else {
          console.log(
            "Nessuna valutazione trovata per projectId:",
            projectId
          );
        }
      } catch (err) {
        console.error("Errore nel recupero valutazione per editing:", err);
      }
    }
    // ✅ EDITING+CORREZIONE BOZZE (DEFAULT FERMENTO) - UNICO
// 🔥 ORA PASSA DAL CHUNKING (editing deciso) usando editing-fermento-B.txt
if (mode === "editing-fermento" || mode === "editing" || mode === "editing-default") {
   // ✅ profilo grafico arrivato dalla UI (se manca, fallback)
  const selectedGraphicProfile = graphicProfile || "Narrativa contemporanea";

  // ✅ carica regole profilo da JSON (server/rules/graphic-profiles.json)
  let graphicRulesBlock = "";
  try {
    const gpPath = path.join(process.cwd(), "rules", "graphic-profiles.json");
    const gpRaw = fs.readFileSync(gpPath, "utf8");
    const gpData = JSON.parse(gpRaw);

    const profiles = Array.isArray(gpData?.profiles) ? gpData.profiles : [];
    const found =
      profiles.find((p) => p.label === selectedGraphicProfile) ||
      profiles.find((p) => p.id === gpData?.defaultProfileId) ||
      profiles[0];

    const hardList = Array.isArray(found?.rules?.hardConstraintsText)
      ? found.rules.hardConstraintsText
      : [];

    graphicRulesBlock = [
      `PROFILO GRAFICO SELEZIONATO (VINCOLANTE): ${found?.label || selectedGraphicProfile}`,
      "",
      "VINCOLI (obbligatori):",
      ...(hardList.length ? hardList.map((s) => `– ${s}`) : ["– Il profilo grafico è vincolante."]),
      "",
      "REGOLE TIPOGRAFICHE (non negoziabili):",
      "– NON convertire segni di dialogo (trattini/virgolette/caporali).",
      "– NON convertire virgolette (\" “ ” « ») da una forma all’altra.",
      "– NON normalizzare puntini di sospensione (... ↔ …).",
      "– NON normalizzare trattini (- ↔ – ↔ —).",
      "– NON cambiare apostrofi o accenti tipografici.",
      "– NON alterare spaziature, a capo, paragrafi."
    ].join("\n");
  } catch (e) {
    graphicRulesBlock = [
      `PROFILO GRAFICO SELEZIONATO (VINCOLANTE): ${selectedGraphicProfile}`,
      "Regola assoluta: NON convertire dialoghi, virgolette, trattini o segni tipografici. Mantieni la grafica originale salvo errori evidenti."
    ].join("\n");
  }

  const baseSystemMessage = fs.readFileSync(
    path.join(process.cwd(), "prompts", "editing-fermento-B.txt"),
    "utf8"
  );

  let systemForChunk = baseSystemMessage;

  // ✅ inietta regole profilo nel prompt
  systemForChunk += "\n\n" + graphicRulesBlock + "\n";



  // Se c'è valutazione, la rendiamo vincolante anche qui
  if (evaluationSnippet) {
    systemForChunk +=
      "\n\nISTRUZIONI AGGIUNTIVE (OBBLIGATORIE): devi applicare in modo prioritario la seguente VALUTAZIONE EDITORIALE (estratto).\n\n" +
      evaluationSnippet;
  }

  const chunks = chunkText(text, 15000);
  console.log("EDITING a chunk, mode:", mode, "numero chunks:", chunks.length);

  let allEdited = "";
  const MAX_PROMPT_CHARS_LOCAL = 60000;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    let chunkUserMessage = [
     "Esegui un EDITING + CORREZIONE BOZZE: migliora chiarezza e scorrevolezza SENZA tagliare, condensare o riscrivere in modo creativo.",
      "ma NON cambiare fatti, eventi, personaggi, luoghi né l’ordine delle scene.",
      "Restituisci SOLO HTML NUDO usando SOLO <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>.",
      "",
      chunk,
    ].join("\n");

    if (chunkUserMessage.length > MAX_PROMPT_CHARS_LOCAL) {
      console.log("chunkUserMessage troppo lungo, lo taglio da", chunkUserMessage.length, "a", MAX_PROMPT_CHARS_LOCAL);
      chunkUserMessage = chunkUserMessage.slice(0, MAX_PROMPT_CHARS_LOCAL);
    }

    const completionChunk = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemForChunk },
        { role: "user", content: chunkUserMessage },
      ],
    });

    const aiChunk = completionChunk.choices?.[0]?.message?.content?.trim() || "";

    const cleanedChunk = aiChunk
      .replace(/<p>\s*\**\s*Sezione\s+\d+\s*\/\s*\d+[^<]*<\/p>/gi, "")
      .replace(/\**\s*Sezione\s+\d+\s*\/\s*\d+[^\n]*\**/gi, "")
      .trim();

    const fixedChunk = applyTypographicFixes(cleanedChunk);

    allEdited += fixedChunk + "\n\n";
  }

  return res.json({
    success: true,
    result: allEdited.trim(),
  });
}


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
        "Restituisci SOLO il testo corretto.",
      ].join("\n");

      userMessage = ["Correggi il testo seguente:", "", text].join("\n");
    }

    // 🌍 TRADUZIONE ITA → ENG
    else if (mode === "traduzione-it-en") {
      systemMessage = [
        "Sei un traduttore professionista dall'italiano all'inglese.",
        "Mantieni il significato e il tono del testo, ma usa un inglese naturale e scorrevole.",
        "Non aggiungere spiegazioni, non commentare, non cambiare il contenuto.",
        "Restituisci SOLO la traduzione inglese.",
      ].join("\n");

      userMessage = "Traduci in inglese:\n\n" + text;
    }

       // ✏️ EDITING – GESTITO A CHUNK DA 15.000 CARATTERI
    if (
      mode &&
      typeof mode === "string" &&
      mode.toLowerCase().includes("edit") &&
      mode !== "editing" &&
      mode !== "editing-default" &&
      mode !== "editing-fermento"
    ) {

      const m = mode.toLowerCase();

      let livello = "moderato";
      if (m.includes("soft") || m.includes("legger")) livello = "leggero";
      else if (m.includes("profond") || m.includes("deep")) livello = "profondo";

      let dettagliLivello = "";

      if (livello === "leggero") {
        dettagliLivello = [
          "- Interventi MINIMI sulla forma delle frasi.",
          "- Mantieni almeno l'80–90% delle formulazioni originali.",
          "- Limita l'intervento a piccole riformulazioni dove il testo è davvero rigido o poco chiaro.",
        ].join("\n");
      } else if (livello === "moderato") {
        dettagliLivello = [
          "- Riscrivi senza esitazione le frasi deboli o prolisse.",
          "- Migliora ritmo, chiarezza e coesione interna in tutto il testo.",
          "- Taglia ripetizioni inutili e frasi tortuose.",
        ].join("\n");
      } else if (livello === "profondo") {
        dettagliLivello = [
          "- Puoi e DEVI riscrivere in modo deciso ogni frase che risulta piatta, prolissa o poco efficace.",
          "- Il risultato deve essere chiaramente diverso a livello di forma, pur mantenendo identici i contenuti.",
          "- Rafforza i dialoghi rendendoli naturali e credibili.",
          "- Migliora il ritmo narrativo tagliando ridondanze e alleggerendo le parti pesanti.",
        ].join("\n");
      }

    let baseSystemMessage = fs.readFileSync(
  path.join(process.cwd(), "prompts", "editing-fermento-B.txt"),
  "utf8"
);

      if (evaluationSnippet) {
        baseSystemMessage +=
          "\n\nISTRUZIONI AGGIUNTIVE (OBBLIGATORIE): " +
          "devi applicare in modo prioritario la seguente VALUTAZIONE EDITORIALE (estratto). " +
          "Ogni intervento di editing deve essere coerente con le critiche e gli interventi richiesti qui sotto:\n\n" +
          evaluationSnippet;
      }

      const chunks = chunkText(text, 15000);
      console.log(
        "EDITING a chunk, mode:",
        mode,
        "numero chunks:",
        chunks.length
      );

      let allEdited = "";
      const MAX_PROMPT_CHARS_LOCAL = 60000;

      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i];

      let chunkUserMessage = [
  "Esegui un editing " + livello.toUpperCase() + " del seguente testo. " +
    "Puoi tagliare e condensare ridondanze e verbosità, ma NON cambiare i fatti, gli eventi, i personaggi, i luoghi né la sequenza della storia.",
  "",
  chunk,
].join("\n");

        if (chunkUserMessage.length > MAX_PROMPT_CHARS_LOCAL) {
          console.log(
            "chunkUserMessage troppo lungo, lo taglio da",
            chunkUserMessage.length,
            "a",
            MAX_PROMPT_CHARS_LOCAL
          );
          chunkUserMessage = chunkUserMessage.slice(0, MAX_PROMPT_CHARS_LOCAL);
        }

        const completionChunk = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: baseSystemMessage },
            { role: "user", content: chunkUserMessage },
          ],
        });

        const aiChunk =
        completionChunk.choices?.[0]?.message?.content?.trim() || "";

      // elimina qualsiasi riga/pezzo che contenga "Sezione 2/3" ecc.
      const cleanedChunk = aiChunk
    .replace(/<p>\s*\**\s*Sezione\s+\d+\s*\/\s*\d+[^<]*<\/p>/gi, "")
    .replace(/\**\s*Sezione\s+\d+\s*\/\s*\d+[^\n]*\**/gi, "")
    .trim();

    const fixedChunk = applyTypographicFixes(cleanedChunk);

       
        allEdited += fixedChunk + "\n\n";
      }

      return res.json({
        success: true,
        result: allEdited.trim(),
      });
    }

    // Fallback per tutte le altre modalità (correzione, traduzione, ecc.)
    if (!userMessage) userMessage = text;

    const MAX_PROMPT_CHARS = 60000;
    if (userMessage && userMessage.length > MAX_PROMPT_CHARS) {
      console.log(
        "userMessage troppo lungo (fallback generico), lo taglio da",
        userMessage.length,
        "a",
        MAX_PROMPT_CHARS
      );
      userMessage = userMessage.slice(0, MAX_PROMPT_CHARS);
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: systemMessage || "" },
        { role: "user", content: userMessage },
      ],
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Errore: nessun testo generato.";

    const fixedText = applyTypographicFixes(aiText);

    console.log(
      "Risposta OpenAI ricevuta (fallback generico), lunghezza:",
      fixedText.length
    );

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
// AVVIO SERVER
// ===============================
app.listen(PORT, () => {
  console.log("### FIRMA BACKEND FERMENTO: INDEX.JS MODIFICATO OGGI ###");
console.log(`Fermento AI backend in ascolto su http://localhost:${PORT}`);

});
