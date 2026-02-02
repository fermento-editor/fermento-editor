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
import { applyTypography } from "./typography/applyTypography.js";
import { redis } from "./redis.js";
import { v4 as uuidv4 } from "uuid";


if (redis) {
  redis.ping()
    .then(() => {
      console.log("✅ Redis connesso correttamente");
    })
    .catch(err => {
      console.error("❌ Redis NON connesso:", err.message);
    });
} else {
  console.warn("⚠️ REDIS_URL non definita");
}


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

// ✅ LOG DI OGNI RICHIESTA (così vedi SEMPRE se arriva una chiamata)
app.use((req, _res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});

// __dirname per ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cartella upload
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

// cartella prompts (dentro /server/prompts)
const promptsDir = path.join(__dirname, "prompts");

// file valutazioni (ARCHIVIO SERVER: lo manteniamo)
const evaluationsPath = path.join(__dirname, "data", "evaluations.json");

// (opzionale) file lista best seller mercato
const marketTopListPath = path.join(__dirname, "data", "marketTopList.json");

// ===============================
//   UTILITY: LETTURA PROMPT ESTERNI
// ===============================
function readPromptFile(filename) {
  const full = path.join(promptsDir, filename);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (err) {
    console.error("Errore readPromptFile:", filename, err?.message || err);
    return "";
  }
}

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
//   UTILITY: LISTA TOP BESTSELLER (MERCATO) - opzionale
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

// ===============================
//   FILTRO TIPOGRAFICO (leggero)
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
  t = t.replace(/([a-zA-ZÀ-ÿ])"(?=[A-Za-zÀ-ÿ])/g, '$1 "');

  return t;
}

// =========================
// FUNZIONE UNICA DI SPEZZETTAMENTO
// =========================
function chunkText(text, chunkSize = 15000) {
  const s = typeof text === "string" ? text : String(text || "");
  const chunks = [];
  let index = 0;
  while (index < s.length) {
    chunks.push(s.slice(index, index + chunkSize));
    index += chunkSize;
  }
  return chunks;
}

// =========================
// DOCX HTML PARAGRAPH UTILITIES (per preservare struttura)
// =========================
function extractParagraphs(html) {
  if (!html || typeof html !== "string") return [];
  const matches = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
  return matches ? matches : [];
}

function stripTagsToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

// Split <p> con <br> in più <p> (scelta B)
function splitParagraphOnBr(pHtml) {
  const inner = pHtml
    .replace(/^<p\b[^>]*>/i, "")
    .replace(/<\/p>\s*$/i, "");

  if (!/<br\s*\/?>/i.test(inner)) return [pHtml];

  const parts = inner.split(/<br\s*\/?>/i);

  // manteniamo anche righe vuote
  return parts.map((part) => `<p>${part}</p>`);
}

// Regola titoli capitolo/sezione: NON mandarli all'AI
function isChapterTitleParagraph(pHtml) {
  const text = stripTagsToText(pHtml);
  if (!text) return false;
  return /^capitolo\b/i.test(text);
}

function looksLikeDocxHtml(text) {
  return typeof text === "string" && /<p\b/i.test(text);
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Ripulisce output AI: deve diventare ESATTAMENTE un <p>...</p>
function normalizeAiParagraph(aiText) {
  const s = String(aiText || "").trim();

  // togli eventuali recinzioni
  const noFences = s.replace(/```[\s\S]*?```/g, "").trim();

  // prendi il primo <p>...</p>
  const m = noFences.match(/<p\b[^>]*>[\s\S]*?<\/p>/i);
  if (m) return m[0].trim();

  // fallback: incapsula (meglio che perdere struttura)
  return `<p>${noFences}</p>`;
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

        if (!pdfParseFn) throw new Error("Modulo pdf-parse-fixed non compatibile");

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
// JOB API (persistente su Redis)
// ===============================
const JOB_TTL_SECONDS = 60 * 60; // 1 ora

async function setJob(jobId, fields) {
  const jobKey = `job:${jobId}`;
  await redis.hset(jobKey, fields);
  await redis.expire(jobKey, JOB_TTL_SECONDS);
}

async function getJob(jobId) {
  const jobKey = `job:${jobId}`;
  const data = await redis.hgetall(jobKey);
  return data && Object.keys(data).length ? data : null;
}

// Worker "finto" (per test pipeline)
async function processJobFake(jobId) {
  try {
    await setJob(jobId, { status: "running", progress: "0.05" });

    await new Promise(r => setTimeout(r, 1200));
    await setJob(jobId, { progress: "0.60" });

    await new Promise(r => setTimeout(r, 1200));
    await setJob(jobId, { progress: "0.95" });

    await redis.set(
      `job:${jobId}:result`,
      JSON.stringify({ ok: true, message: "FAKE RESULT (pipeline OK)" }),
      "EX",
      JOB_TTL_SECONDS
    );

    await setJob(jobId, { status: "done", progress: "1.0" });
  } catch (e) {
    await setJob(jobId, { status: "error", error: String(e?.message || e) });
  }
}

// 1) Crea job
app.post("/api/ai-job", async (req, res) => {
  try {
    if (!redis) return res.status(500).json({ success: false, error: "Redis non configurato" });

    const jobId = uuidv4();

    await setJob(jobId, {
      status: "queued",
      progress: "0",
      createdAt: String(Date.now()),
    });

    await redis.set(
      `job:${jobId}:payload`,
      JSON.stringify(req.body || {}),
      "EX",
      JOB_TTL_SECONDS
    );

    setImmediate(() => processJobFake(jobId));

    return res.json({ success: true, jobId });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 2) Stato job
app.get("/api/ai-job/:id", async (req, res) => {
  try {
    if (!redis) return res.status(500).json({ success: false, error: "Redis non configurato" });

    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: "Job non trovato" });

    return res.json({
      success: true,
      id: req.params.id,
      status: job.status || "unknown",
      progress: Number(job.progress || 0),
      error: job.error || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 3) Risultato job
app.get("/api/ai-job/:id/result", async (req, res) => {
  try {
    if (!redis) return res.status(500).json({ success: false, error: "Redis non configurato" });

    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: "Job non trovato" });

    if (job.status !== "done") {
      return res.status(409).json({ success: false, error: "Job non completato", status: job.status });
    }

    const raw = await redis.get(`job:${req.params.id}:result`);
    if (!raw) return res.status(500).json({ success: false, error: "Risultato mancante" });

    return res.json({ success: true, result: JSON.parse(raw) });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});


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

    let safeHtml = html;
    safeHtml = safeHtml.replace(/è\"/g, 'è "').replace(/\"/g, '"');

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
//   DOCX PRESERVE (multipart) - alias operativo
// ===============================
app.post("/api/docx/editing-preserve", upload.single("file"), async (req, res) => {
  try {
    const html = req.body?.html;

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "html mancante nel body (multipart)",
      });
    }

    let safeHtml = html;
    safeHtml = safeHtml.replace(/è\"/g, 'è "').replace(/\"/g, '"');

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
    res.setHeader("Content-Disposition", 'attachment; filename="OUT.docx"');

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
//  API VALUTAZIONI (GET / POST / DELETE / DOCX) — MANTENUTE
// ===========================
app.get("/api/evaluations", async (req, res) => {
  try {
    const projectId = req.query.projectId || null;
    const list = await loadEvaluations();

    let filtered = list;
    if (projectId) {
      filtered = list.filter((ev) => !ev.projectId || ev.projectId === projectId);
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

    const wrappedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    ${html}
  </body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, {
      font: "Times New Roman",
      fontSize: 24,
    });

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
// ===============================
// JOB API (anti-timeout per testi lunghi)
// ===============================
const JOBS = new Map(); // jobId -> { status, progress, total, result, error, startedAt }

function newJobId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Esegue un job chiamando internamente /api/ai (così NON duplichiamo la logica)
async function runAiJob(jobId, body) {
  const j = JOBS.get(jobId);
  if (!j) return;

  try {
    j.status = "running";
    j.progress = 0;
    j.total = 1;

    // Chiamata interna al nostro stesso backend (evita timeout del browser/proxy)
    const url = `http://127.0.0.1:${PORT}/api/ai`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || !data?.success) {
      j.status = "error";
      j.error = data?.error || `HTTP ${resp.status} ${resp.statusText}`;
      j.progress = 1;
      return;
    }

    j.result = data.result;
    j.status = "done";
    j.progress = 1;
  } catch (err) {
    j.status = "error";
    j.error = String(err?.message || err);
    j.progress = 1;
  }
}


app.post("/api/ai-job/start", async (req, res) => {
  try {
    const jobId = newJobId();
    JOBS.set(jobId, {
      status: "running",
      progress: 0,
      total: 0,
      result: null,
      error: null,
      startedAt: Date.now(),
    });

    // Avvio asincrono: NON blocco la risposta HTTP
    runAiJob(jobId, req.body).catch((err) => {
      const j = JOBS.get(jobId);
      if (j) {
        j.status = "error";
        j.error = String(err?.message || err);
      }
    });

    return res.json({ success: true, jobId });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/api/ai-job/status", (req, res) => {
  const { jobId } = req.query || {};
  const j = JOBS.get(String(jobId || ""));
  if (!j) return res.status(404).json({ success: false, error: "jobId non trovato" });
  return res.json({
    success: true,
    status: j.status,
    progress: j.progress,
    total: j.total,
    error: j.error,
  });
});

app.get("/api/ai-job/result", (req, res) => {
  const { jobId } = req.query || {};
  const j = JOBS.get(String(jobId || ""));
  if (!j) return res.status(404).json({ success: false, error: "jobId non trovato" });
  if (j.status !== "done") {
    return res.status(400).json({ success: false, error: "Job non completato", status: j.status });
  }
  return res.json({ success: true, result: j.result });
});



app.post("/api/ai", async (req, res) => {
  console.log(">>> /api/ai chiamata, mode:", req.body?.mode);

  try {
    const {
      text = "",
      inputText = "",
      html = "",
      inputHtml = "",
      mode,
      projectTitle = "",
      projectAuthor = "",
      projectId = null,
      useEvaluationForEditing = false,
      currentEvaluation = "",
      // compat col frontend
      graphicProfile = "Narrativa contemporanea",
    } = req.body || {};

    // ✅ TESTO EFFETTIVO: prendiamo il primo campo non vuoto
    let textEffective = typeof text === "string" ? text : String(text || "");
    if (!textEffective.trim()) {
      const a = typeof inputText === "string" ? inputText : String(inputText || "");
      const b = typeof html === "string" ? html : String(html || "");
      const c = typeof inputHtml === "string" ? inputHtml : String(inputHtml || "");
      textEffective = (a && a.trim()) ? a : (b && b.trim()) ? b : (c && c.trim()) ? c : "";
    }

    console.log("AI textEffective length:", textEffective.length);

    // ==========================
    // 1) VALUTAZIONE (PROMPT ESTERNO)
    // ==========================
    if (mode === "valutazione" || mode === "valutazione-manoscritto") {
      const valutazionePrompt = readPromptFile("valutazione-fermento.txt");
      if (!valutazionePrompt.trim()) {
        return res.status(500).json({
          success: false,
          error: "Prompt valutazione-fermento.txt mancante o vuoto",
        });
      }

      // opzionale: snippet top list mercato
      let topListSnippet = "";
      try {
        const topList = await loadMarketTopList();
        if (Array.isArray(topList) && topList.length > 0) {
          topListSnippet = JSON.stringify(topList).slice(0, 15000);
        }
      } catch (err) {
        console.error("Errore nel caricamento Top 10 mercato:", err);
      }

      // spezzettiamo in sezioni grandi
      const chunks = chunkText(textEffective, 80000);
      console.log("VALUTAZIONE: numero chunks:", chunks.length);

      const partialAnalyses = [];

      for (let i = 0; i < chunks.length; i++) {
        const sectionHeader =
          `SEZIONE ${i + 1}/${chunks.length}\n` +
          `Titolo: ${projectTitle || "Titolo mancante"}\n` +
          `Autore: ${projectAuthor || "Autore mancante"}\n`;

        const p = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content: valutazionePrompt + "\n\n[FASE: ANALISI SEZIONE]\n" + sectionHeader,
            },
            { role: "user", content: chunks[i] },
          ],
        });

        partialAnalyses.push(p.choices?.[0]?.message?.content?.trim() || "");
      }

      const synthesisUser =
        `DATI:\n` +
        `Titolo: ${projectTitle || "Titolo mancante"}\n` +
        `Autore: ${projectAuthor || "Autore mancante"}\n\n` +
        (topListSnippet ? `DATI DI MERCATO (JSON):\n${topListSnippet}\n\n` : "") +
        `ANALISI PARZIALI:\n` +
        partialAnalyses.join("\n\n--- SEZIONE ---\n\n");

      const final = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: valutazionePrompt + "\n\n[FASE: SINTESI FINALE]" },
          { role: "user", content: synthesisUser },
        ],
      });

      const finalText =
        final.choices?.[0]?.message?.content?.trim() || "Errore nella valutazione finale.";

      const fixedText = applyTypographicFixes(finalText);

      // salviamo nell’archivio valutazioni
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
    }

    // ==========================
    // 2) EDITING FERMENTO (PROMPT ESTERNO)
    //    - SOLO DOCX: paragrafo-per-paragrafo per preservare struttura
    // ==========================
    if (mode === "editing-fermento" || mode === "editing" || mode === "editing-default") {
      let systemForChunk = readPromptFile("editing-fermento-B.txt");
      if (!systemForChunk.trim()) {
        return res.status(500).json({
          success: false,
          error: "Prompt editing-fermento-B.txt mancante o vuoto",
        });
      }

      // (opzionale) valutazione dal frontend per guidare editing
      if (useEvaluationForEditing && currentEvaluation && currentEvaluation.trim().length > 0) {
        const evaluationSnippet = currentEvaluation.trim().slice(0, 2000);
        systemForChunk +=
          "\n\nISTRUZIONI AGGIUNTIVE (OBBLIGATORIE): applica prioritariamente questo estratto di VALUTAZIONE EDITORIALE:\n\n" +
          evaluationSnippet;
      }

          // Se non arriva HTML da DOCX, ma arriva testo/paragrafi, ricostruisco HTML minimale <p>...</p>
      let htmlEffective = textEffective;

      // se non è già HTML con <p>, provo a convertirlo da testo (paragrafi separati da righe vuote)
      if (!looksLikeDocxHtml(htmlEffective)) {
        const maybePlainText =
          typeof htmlEffective === "string" &&
          htmlEffective.trim().length > 0 &&
          !htmlEffective.includes("<p");

        if (maybePlainText) {
          const paragraphs = htmlEffective
            .split(/\r?\n\s*\r?\n|\r?\n{2,}/)
            .map((s) => s.trim())
            .filter(Boolean);

          htmlEffective = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
        }
      }

      // controllo finale: ora DEVE sembrare HTML da DOCX
      if (!looksLikeDocxHtml(htmlEffective)) {
        return res.status(400).json({
          success: false,
          error:
            "Editing-fermento supportato solo su input DOCX (HTML con <p>...). L’input ricevuto non sembra HTML da DOCX.",
        });
      }

      // 1) Estrai <p>
      const originalParagraphs = extractParagraphs(htmlEffective);



      // 2) Normalizza: split su <br> => più <p> (scelta B)
      const normalizedParagraphs = [];
      for (const p of originalParagraphs) {
        normalizedParagraphs.push(...splitParagraphOnBr(p));
      }

      console.log(
        "EDITING DOCX FLOW: paragraphs original:",
        originalParagraphs.length,
        "normalized:",
        normalizedParagraphs.length
      );

      // Ricostruzione output mantenendo ESATTAMENTE l'ordine originale
      const outputParts = new Array(normalizedParagraphs.length).fill(null);

      // ====== BATCH SETTINGS (anti-timeout + anti-mismatch) ======
      const BATCH_MAX_PARAS = 10;      // meno paragrafi per batch = meno errori di conteggio
      const BATCH_MAX_CHARS = 9000;    // batch più piccoli = output più controllabile

      // ====== 1) Costruisci lista paragrafi editabili (con indice) ======
      const editable = []; // { idx, pHtml }
      for (let i = 0; i < normalizedParagraphs.length; i++) {
        const pHtml = normalizedParagraphs[i];

        // Mantieni paragrafi vuoti (regola A)
        const textOnly = stripTagsToText(pHtml);
        if (!textOnly) {
          outputParts[i] = "<p></p>";
          continue;
        }

        // Mantieni titoli identici (CAPITOLO X ecc.)
        if (isChapterTitleParagraph(pHtml)) {
          outputParts[i] = `<p>${stripTagsToText(pHtml)}</p>`;
          continue;
        }

        editable.push({ idx: i, pHtml });
      }

      // ====== 2) Crea batches ======
      const batches = [];
      let cur = [];
      let curChars = 0;

      for (const item of editable) {
        const len = item.pHtml.length;

        const exceed =
          cur.length >= BATCH_MAX_PARAS ||
          (curChars + len) > BATCH_MAX_CHARS;

        if (exceed && cur.length > 0) {
          batches.push(cur);
          cur = [];
          curChars = 0;
        }

        cur.push(item);
        curChars += len;
      }
      if (cur.length > 0) batches.push(cur);

      console.log("EDITING BATCHES:", batches.length, "editable paragraphs:", editable.length);

      // ====== Helper: fallback per-paragrafo (solo se batch fallisce) ======
      async function editSingleParagraph(pHtml) {
        const userMsg = [
          "Devi riscrivere SOLO questo singolo paragrafo.",
          "VINCOLI:",
          "- Devi restituire ESATTAMENTE UN SOLO <p>...</p> (uno e uno solo).",
          "- Vietato creare più paragrafi o fonderlo con altri.",
          "- Vietato aggiungere prefazioni o commenti.",
          "- Tag ammessi: <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>.",
          "",
          "PARAGRAFO INPUT:",
          pHtml,
        ].join("\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: systemForChunk },
            { role: "user", content: userMsg },
          ],
        });

        const ai = completion.choices?.[0]?.message?.content?.trim() || "";
        return normalizeAiParagraph(ai);
      }

         // ====== 3) Esegui batches con concorrenza limitata ======
      const CONCURRENCY = 1;

      async function processOneBatch(b) {
        const batch = batches[b];
        const batchInput = batch.map((x) => x.pHtml).join("\n");

        const userMsg = [
          "Devi riscrivere i paragrafi qui sotto.",
          "VINCOLI ASSOLUTI:",
          `- Devi restituire ESATTAMENTE ${batch.length} elementi in un JSON array (solo JSON, nessun altro testo).`,
          "- Ogni elemento dell'array deve essere una stringa che contiene ESATTAMENTE UN SOLO <p>...</p> (uno e uno solo).",
          "- Devi mantenere ESATTAMENTE lo stesso ordine degli input.",
          "- Vietato unire o spezzare paragrafi.",
          "- Vietato aggiungere prefazioni, commenti, markdown o backticks.",
          "- Tag ammessi dentro i <p>: <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>.",
          "",
          "INPUT (paragrafi <p>...</p> uno dopo l'altro):",
          batchInput,
        ].join("\n");

        console.log(`EDITING batch ${b + 1}/${batches.length} - paras: ${batch.length}`);

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: systemForChunk },
            { role: "user", content: userMsg },
          ],
        });

        let aiText = completion.choices?.[0]?.message?.content?.trim() || "";

        // Ripulisci eventuali ```json ... ```
        aiText = aiText.replace(/^```(?:json)?\s*/i, "").replace(/```[\s\r\n]*$/i, "").trim();

        let pList = [];
        try {
          const parsed = JSON.parse(aiText);
          if (Array.isArray(parsed)) pList = parsed;
        } catch (e) {
          pList = [];
        }

        // Retry 1 volta se mismatch
        if (pList.length !== batch.length) {
          console.log(
            "WARN batch mismatch -> retry once. expected:",
            batch.length,
            "got:",
            pList.length
          );

          const retryMsg = [
            "ERRORE: prima non hai restituito il JSON corretto o il numero corretto di elementi.",
            `Devi restituire SOLO un JSON array di lunghezza ESATTA ${batch.length}.`,
            "Ogni elemento deve essere una stringa con ESATTAMENTE UN SOLO <p>...</p>.",
            "Nessun altro testo. Nessun markdown. Nessun backtick.",
            "",
            "INPUT:",
            batchInput,
          ].join("\n");

          const retry = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            messages: [
              { role: "system", content: systemForChunk },
              { role: "user", content: retryMsg },
            ],
          });

          let retryText = retry.choices?.[0]?.message?.content?.trim() || "";
          retryText = retryText.replace(/^```(?:json)?\s*/i, "").replace(/```[\s\r\n]*$/i, "").trim();

          pList = [];
          try {
            const parsedRetry = JSON.parse(retryText);
            if (Array.isArray(parsedRetry)) pList = parsedRetry;
          } catch (e) {
            pList = [];
          }
        }

        // Se ancora mismatch: fallback per-paragrafo (solo per questo batch)
        if (pList.length !== batch.length) {
          console.log("ERROR batch mismatch persists -> fallback to single-paragraph for this batch.");
          for (const item of batch) {
            const pOut = await editSingleParagraph(item.pHtml);
            outputParts[item.idx] = pOut;
          }
          return;
        }

        // OK: assegna ogni paragrafo ESATTAMENTE al suo indice originale
        for (let j = 0; j < batch.length; j++) {
          outputParts[batch[j].idx] = normalizeAiParagraph(String(pList[j] ?? ""));
        }
      }

      // Worker pool
      let next = 0;
      async function worker() {
        while (next < batches.length) {
          const b = next++;
          await processOneBatch(b);
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));


// ====== 4) Ricomponi output in ordine ======
const out = outputParts
  .map((p) => (p == null ? "<p></p>" : p))
  .join("\n");

return res.json({
  success: true,
  result: out.trim(),
  meta: {
    docxFlow: true,
    paragraphsOriginal: originalParagraphs.length,
    paragraphsNormalized: normalizedParagraphs.length,
  },
});
}


    // ==========================
    // 3) TRADUZIONE ITA->ENG (PROMPT ESTERNO)
    // ==========================
    if (mode === "traduzione-it-en") {
      const translationPrompt = readPromptFile("traduzione-it-en.txt");
      if (!translationPrompt.trim()) {
        return res.status(500).json({
          success: false,
          error: "Prompt traduzione-it-en.txt mancante o vuoto",
        });
      }

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: translationPrompt },
          { role: "user", content: textEffective },
        ],
      });

      const aiText =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Errore: nessun testo generato.";

      return res.json({
        success: true,
        result: aiText,
      });
    }

    // ==========================
    // MODE NON SUPPORTATA
    // ==========================
    return res.status(400).json({
      success: false,
      error: `Mode non supportata: ${mode || "(mancante)"}`,
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
// AVVIO SERVER
// ===============================
app.listen(PORT, () => {
  console.log("### FIRMA BACKEND FERMENTO: INDEX.JS MODIFICATO OGGI ###");
  console.log(`Fermento AI backend in ascolto su http://localhost:${PORT}`);
});
