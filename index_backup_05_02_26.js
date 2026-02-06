// server/index.js - Fermento Editor backend (DOCX + PDF + AI)
// SINGLE SOURCE OF TRUTH per JOB: Redis
// Endpoint JOB unici: /api/ai-job/start | /api/ai-job/status | /api/ai-job/result
//
// MODE SUPPORTATE (canoniche):
// - valutazione
// - editing-originale
// - riscrittura-traduzione
// - traduzione-it-en
//
// Alias compatibilità frontend storico:
// - valutazione-manoscritto -> valutazione
// - editing / editing-fermento / editing-default -> editing-originale
// - traduzione-riscrittura / traduzione-riscrittura-fermento -> riscrittura-traduzione
// - traduzione-it-en -> traduzione-it-en
//
// Prompt esterni in /server/prompts (modificabili senza toccare index.js):
// - valutazione-fermento.txt
// - editing-originale.txt
// - riscrittura-traduzione.txt
// - traduzione-it-en.txt
//
// Export DOCX:
// - /api/export-docx (JSON {html})
// - /api/docx/editing-preserve (multipart: file + html)

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
import { v4 as uuidv4 } from "uuid";

// ===============================
// ENV
// ===============================
dotenv.config();

// ===============================
// REDIS (dynamic import dopo dotenv)
// ===============================
let redis = null;
async function initRedis() {
  try {
    const mod = await import("./redis.js");
    redis = mod.redis || null;

    if (redis) {
      await redis.ping();
      console.log("✅ Redis connesso correttamente");
    } else {
      console.warn("⚠️ REDIS_URL non definita (redis = null)");
    }
  } catch (err) {
    console.error("❌ Errore init Redis:", err?.message || err);
    redis = null;
  }
}

// ===============================
// CLIENT OPENAI
// ===============================
const AI_MODEL = process.env.AI_MODEL || "gpt-5.2";
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
console.log("OPENAI_API_KEY presente?", !!process.env.OPENAI_API_KEY);
console.log("AI_MODEL:", AI_MODEL);

// ===============================
// APP + CONFIG
// ===============================
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ✅ LOG DI OGNI RICHIESTA
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

// file valutazioni (ARCHIVIO SERVER)
const evaluationsPath = path.join(__dirname, "data", "evaluations.json");

// ===============================
// UTILITY: LETTURA PROMPT ESTERNI
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
// UTILITY: LETTURA/SCRITTURA VALUTAZIONI
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
    await fsPromises.writeFile(evaluationsPath, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("Errore saveEvaluations:", err);
  }
}

// ===============================
// FILTRO TIPOGRAFICO (leggero)
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
function chunkText(text, chunkSize = 80000) {
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
// DOCX HTML PARAGRAPH UTILITIES
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

// Split <p> con <br> in più <p>
function splitParagraphOnBr(pHtml) {
  const inner = pHtml
    .replace(/^<p\b[^>]*>/i, "")
    .replace(/<\/p>\s*$/i, "");

  if (!/<br\s*\/?>/i.test(inner)) return [pHtml];

  const parts = inner.split(/<br\s*\/?>/i);
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
  const noFences = s.replace(/```[\s\S]*?```/g, "").trim();
  const m = noFences.match(/<p\b[^>]*>[\s\S]*?<\/p>/i);
  if (m) return m[0].trim();
  return `<p>${noFences}</p>`;
}

// ===============================
// UPLOAD DOCX/PDF (contratto stabile per frontend)
// ===============================
async function handleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Nessun file caricato" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    // PDF → testo semplice
    if (ext === ".pdf") {
      try {
        const buffer = await fsPromises.readFile(req.file.path);
        const pdfModule = await import("pdf-parse-fixed");

        const pdfParseFn =
          typeof pdfModule.default === "function"
            ? pdfModule.default
            : typeof pdfModule === "function"
            ? pdfModule
            : pdfModule.pdfParse;

        if (!pdfParseFn) throw new Error("Modulo pdf-parse-fixed non compatibile");

        const result = await pdfParseFn(buffer);
        const text = result.text || "";

        await fsPromises.unlink(req.file.path).catch(() => {});
        return res.json({ success: true, type: "pdf", text });
      } catch (err) {
        console.error("Errore parsing PDF:", err);
        await fsPromises.unlink(req.file.path).catch(() => {});
        return res.status(500).json({ success: false, error: "Errore nella lettura del PDF" });
      }
    }

    // DOCX → HTML
    if (ext === ".docx") {
      const buffer = await fsPromises.readFile(req.file.path);
      const result = await mammoth.convertToHtml({ buffer });
      const html = result.value || "";

      await fsPromises.unlink(req.file.path).catch(() => {});
      // ✅ ritorniamo SEMPRE sia html che text per compatibilità massima
      return res.json({ success: true, type: "docx", html, text: html });
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
// JOB API (Redis) — single source of truth
// ===============================
const JOB_TTL_SECONDS = 60 * 60; // 1 ora

async function setJob(jobId, fields) {
  if (!redis) throw new Error("Redis non configurato");
  const jobKey = `job:${jobId}`;
  await redis.hset(jobKey, fields);
  await redis.expire(jobKey, JOB_TTL_SECONDS);
}

async function getJob(jobId) {
  if (!redis) return null;
  const jobKey = `job:${jobId}`;
  const data = await redis.hgetall(jobKey);
  return data && Object.keys(data).length ? data : null;
}

// CORE JOB: esegue la richiesta lunga senza fetch interno
async function processJobReal(jobId) {
  try {
    await setJob(jobId, { status: "running", progress: "0.01" });

    const rawPayload = await redis.get(`job:${jobId}:payload`);
    const body = rawPayload ? JSON.parse(rawPayload) : {};

    const result = await runAiCore(body);

    await redis.set(
      `job:${jobId}:result`,
      JSON.stringify(result ?? null),
      "EX",
      JOB_TTL_SECONDS
    );

    await setJob(jobId, { status: "done", progress: "1.0" });
  } catch (e) {
    try {
      await setJob(jobId, {
        status: "error",
        progress: "1",
        error: String(e?.message || e),
      });
    } catch (_e2) {
      console.error("❌ processJobReal error:", e?.message || e);
    }
  }
}

app.post("/api/ai-job/start", async (req, res) => {
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

    setImmediate(() => processJobReal(jobId));
    return res.json({ success: true, jobId });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/api/ai-job/status", async (req, res) => {
  try {
    if (!redis) return res.status(500).json({ success: false, error: "Redis non configurato" });

    const { jobId } = req.query || {};
    const job = await getJob(String(jobId || ""));
    if (!job) return res.status(404).json({ success: false, error: "jobId non trovato" });

    return res.json({
      success: true,
      status: job.status || "unknown",
      progress: Number(job.progress || 0),
      total: Number(job.total || 0),
      error: job.error || null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

app.get("/api/ai-job/result", async (req, res) => {
  try {
    if (!redis) return res.status(500).json({ success: false, error: "Redis non configurato" });

    const { jobId } = req.query || {};
    const jobIdStr = String(jobId || "");

    const raw = await redis.get(`job:${jobIdStr}:result`);
    if (raw) {
      return res.json({ success: true, result: raw ? JSON.parse(raw) : null });
    }

    const job = await getJob(jobIdStr);
    if (!job) return res.status(404).json({ success: false, error: "jobId non trovato" });

    return res.status(400).json({
      success: false,
      error: "Risultato mancante o job non completato",
      status: job.status,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// ===============================
// EXPORT HTML -> DOCX
// ===============================
app.post("/api/export-docx", async (req, res) => {
  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ success: false, error: "html mancante nel body" });
    }

    let safeHtml = html;
    safeHtml = safeHtml.replace(/è\"/g, 'è "').replace(/\"/g, '"');

    const wrappedHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>${safeHtml}</body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, {
      font: "Times New Roman",
      fontSize: 24,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="document.docx"');
    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore /api/export-docx:", err);
    return res.status(500).json({ success: false, error: "Errore durante la conversione in DOCX" });
  }
});

// ===============================
// DOCX PRESERVE (multipart)
// ===============================
app.post("/api/docx/editing-preserve", upload.single("file"), async (req, res) => {
  try {
    const html = req.body?.html;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ success: false, error: "html mancante nel body (multipart)" });
    }

    let safeHtml = html;
    safeHtml = safeHtml.replace(/è\"/g, 'è "').replace(/\"/g, '"');

    const wrappedHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>${safeHtml}</body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, {
      font: "Times New Roman",
      fontSize: 24,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="OUT.docx"');
    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore /api/docx/editing-preserve:", err);
    return res.status(500).json({ success: false, error: "Errore durante la conversione in DOCX (preserve)" });
  }
});

// ===========================
// API VALUTAZIONI (server archive) — mantenute
// ===========================
app.get("/api/evaluations", async (req, res) => {
  try {
    const projectId = req.query.projectId || null;
    const list = await loadEvaluations();
    let filtered = list;
    if (projectId) {
      filtered = list.filter((ev) => !ev.projectId || ev.projectId === projectId);
    }
    return res.json({ success: true, evaluations: filtered });
  } catch (err) {
    console.error("Errore GET /api/evaluations:", err);
    return res.status(500).json({ success: false, error: "Errore nel caricamento delle valutazioni" });
  }
});

app.get("/api/evaluations/:id", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const found = list.find((v) => v.id === req.params.id);
    if (!found) return res.status(404).json({ success: false, error: "Valutazione non trovata" });
    return res.json({ success: true, evaluation: found });
  } catch (err) {
    console.error("Errore GET /api/evaluations/:id:", err);
    return res.status(500).json({ success: false, error: "Errore lettura valutazione" });
  }
});

app.get("/api/evaluations/:id/docx", async (req, res) => {
  try {
    const list = await loadEvaluations();
    const found = list.find((v) => v.id === req.params.id);
    if (!found) return res.status(404).json({ success: false, error: "Valutazione non trovata" });

    const html = found.html || found.evaluationText || "";
    const wrappedHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>${html}</body>
</html>`;

    const docxBuffer = await htmlToDocx(wrappedHtml, null, { font: "Times New Roman", fontSize: 24 });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    const safeTitle = (found.title || "valutazione").replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 50);
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle || "valutazione"}.docx"`);
    return res.end(docxBuffer);
  } catch (err) {
    console.error("Errore GET /api/evaluations/:id/docx:", err);
    return res.status(500).json({ success: false, error: "Errore export DOCX valutazione" });
  }
});

app.post("/api/evaluations", async (req, res) => {
  try {
    const { projectId = null, fileName = null, title = "Valutazione", author = "", evaluationText = "", meta = {} } = req.body;

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
    return res.json({ success: true, evaluation: newEval });
  } catch (err) {
    console.error("Errore POST /api/evaluations:", err);
    return res.status(500).json({ success: false, error: "Errore nel salvataggio della valutazione" });
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
    return res.status(500).json({ success: false, error: "Errore nella cancellazione della valutazione" });
  }
});

// ===============================
// CORE: PROCESSORE PER-DOCX (BATCH + FALLBACK) — SEZIONE 600K (MANTENUTA)
// ===============================
async function runDocxParagraphPipeline({
  openaiClient,
  systemPrompt,
  htmlEffective,
  modeLabel = "DOCX_PIPELINE",
}) {
  if (!looksLikeDocxHtml(htmlEffective)) {
    throw new Error(`${modeLabel} supportato solo su HTML DOCX con <p>...</p>`);
  }

  const originalParagraphs = extractParagraphs(htmlEffective);

  const normalizedParagraphs = [];
  for (const p of originalParagraphs) normalizedParagraphs.push(...splitParagraphOnBr(p));

  console.log(
    `${modeLabel}: paragraphs original:`,
    originalParagraphs.length,
    "normalized:",
    normalizedParagraphs.length
  );

  const outputParts = new Array(normalizedParagraphs.length).fill(null);

  // Filtra paragrafi non editabili
  const editable = [];
  for (let i = 0; i < normalizedParagraphs.length; i++) {
    const pHtml = normalizedParagraphs[i];
    const textOnly = stripTagsToText(pHtml);

    if (!textOnly) {
      outputParts[i] = "<p></p>";
      continue;
    }
    if (isChapterTitleParagraph(pHtml)) {
      outputParts[i] = `<p>${stripTagsToText(pHtml)}</p>`;
      continue;
    }
    editable.push({ idx: i, pHtml });
  }

  // batching
  const BATCH_MAX_PARAS = 10;
  const BATCH_MAX_CHARS = 9000;

  const batches = [];
  let cur = [];
  let curChars = 0;

  for (const item of editable) {
    const len = item.pHtml.length;
    const exceed = cur.length >= BATCH_MAX_PARAS || curChars + len > BATCH_MAX_CHARS;

    if (exceed && cur.length > 0) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }

    cur.push(item);
    curChars += len;
  }
  if (cur.length > 0) batches.push(cur);

  console.log(`${modeLabel}: BATCHES:`, batches.length);

  async function editSingleParagraph(pHtml) {
    const userMsg = [
      "Devi trasformare SOLO questo singolo paragrafo.",
      "VINCOLI:",
      "- Restituisci ESATTAMENTE UN SOLO <p>...</p> (uno e uno solo).",
      "- Vietato creare più paragrafi o fonderlo con altri.",
      "- Vietato aggiungere commenti o markdown.",
      "- Tag ammessi: <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>.",
      "",
      "PARAGRAFO INPUT:",
      pHtml,
    ].join("\n");

    const completion = await openaiClient.chat.completions.create({
      model: AI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    });

    const ai = completion.choices?.[0]?.message?.content?.trim() || "";
    return normalizeAiParagraph(ai);
  }

  async function processOneBatch(b) {
    const batch = batches[b];
    const batchInput = batch.map((x) => x.pHtml).join("\n");

    const userMsg = [
      "Devi trasformare i paragrafi qui sotto.",
      "VINCOLI ASSOLUTI:",
      `- Devi restituire ESATTAMENTE ${batch.length} elementi in un JSON array (solo JSON, nessun altro testo).`,
      "- Ogni elemento dell'array deve essere una stringa che contiene ESATTAMENTE UN SOLO <p>...</p>.",
      "- Devi mantenere ESATTAMENTE lo stesso ordine degli input.",
      "- Vietato unire o spezzare paragrafi.",
      "- Vietato aggiungere prefazioni, commenti, markdown o backticks.",
      "- Tag ammessi dentro i <p>: <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>.",
      "",
      "INPUT (paragrafi <p>...</p> uno dopo l'altro):",
      batchInput,
    ].join("\n");

    console.log(`${modeLabel} batch ${b + 1}/${batches.length} - paras: ${batch.length}`);

    const completion = await openaiClient.chat.completions.create({
      model: AI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
    });

    let aiText = completion.choices?.[0]?.message?.content?.trim() || "";
    aiText = aiText.replace(/^```(?:json)?\s*/i, "").replace(/```[\s\r\n]*$/i, "").trim();

    let pList = [];
    try {
      const parsed = JSON.parse(aiText);
      if (Array.isArray(parsed)) pList = parsed;
    } catch (_e) {
      pList = [];
    }

    // retry una volta
    if (pList.length !== batch.length) {
      console.log(`${modeLabel} WARN batch mismatch -> retry once. expected:`, batch.length, "got:", pList.length);

      const retryMsg = [
        "ERRORE: prima non hai restituito il JSON corretto o il numero corretto di elementi.",
        `Devi restituire SOLO un JSON array di lunghezza ESATTA ${batch.length}.`,
        "Ogni elemento deve essere una stringa con ESATTAMENTE UN SOLO <p>...</p>.",
        "Nessun altro testo. Nessun markdown. Nessun backtick.",
        "",
        "INPUT:",
        batchInput,
      ].join("\n");

      const retry = await openaiClient.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: retryMsg },
        ],
      });

      let retryText = retry.choices?.[0]?.message?.content?.trim() || "";
      retryText = retryText.replace(/^```(?:json)?\s*/i, "").replace(/```[\s\r\n]*$/i, "").trim();

      pList = [];
      try {
        const parsedRetry = JSON.parse(retryText);
        if (Array.isArray(parsedRetry)) pList = parsedRetry;
      } catch (_e2) {
        pList = [];
      }
    }

    // fallback per-paragrafo
    if (pList.length !== batch.length) {
      console.log(`${modeLabel} ERROR mismatch persists -> fallback single-paragraph for this batch.`);
      for (const item of batch) {
        const pOut = await editSingleParagraph(item.pHtml);
        outputParts[item.idx] = pOut;
      }
      return;
    }

    for (let j = 0; j < batch.length; j++) {
      outputParts[batch[j].idx] = normalizeAiParagraph(String(pList[j] ?? ""));
    }
  }

  // Concorrenza volutamente 1 (stabilità + meno rate-limit)
  const CONCURRENCY = 1;
  let next = 0;

  async function worker() {
    while (next < batches.length) {
      const b = next++;
      await processOneBatch(b);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const out = outputParts.map((p) => (p == null ? "<p></p>" : p)).join("\n").trim();

  return {
    out,
    meta: {
      docxFlow: true,
      paragraphsOriginal: originalParagraphs.length,
      paragraphsNormalized: normalizedParagraphs.length,
      batches: batches.length,
    },
  };
}

// ===============================
// CORE AI (riusabile per job)
// ===============================
async function runAiCore(body) {
  const {
    mode,
    text = "",
    inputText = "",
    html = "",
    inputHtml = "",
    projectTitle = "",
    projectAuthor = "",
    projectId = null,
  } = body || {};

  // ---- NORMALIZZAZIONE MODE (alias) ----
  let modeEffective = String(mode || "").trim();

  if (modeEffective === "valutazione-manoscritto") modeEffective = "valutazione";

  if (modeEffective === "editing" || modeEffective === "editing-fermento" || modeEffective === "editing-default") {
    modeEffective = "editing-originale";
  }

  if (modeEffective === "traduzione-riscrittura" || modeEffective === "traduzione-riscrittura-fermento") {
    modeEffective = "riscrittura-traduzione";
  }

  // testo effettivo
  let textEffective = typeof text === "string" ? text : String(text || "");
  if (!textEffective.trim()) {
    const a = typeof inputText === "string" ? inputText : String(inputText || "");
    const b = typeof html === "string" ? html : String(html || "");
    const c = typeof inputHtml === "string" ? inputHtml : String(inputHtml || "");
    textEffective = a?.trim() ? a : b?.trim() ? b : c?.trim() ? c : "";
  }

  // --- 1) VALUTAZIONE ---
  if (modeEffective === "valutazione") {
    const prompt = readPromptFile("valutazione-fermento.txt");
    if (!prompt.trim()) throw new Error("Prompt valutazione-fermento.txt mancante o vuoto");

    const chunks = chunkText(textEffective, 80000);
    console.log("VALUTAZIONE (job): chunks:", chunks.length);

    const partialAnalyses = [];
    for (let i = 0; i < chunks.length; i++) {
      const sectionHeader =
        `SEZIONE ${i + 1}/${chunks.length}\n` +
        `Titolo: ${projectTitle || "Titolo mancante"}\n` +
        `Autore: ${projectAuthor || "Autore mancante"}\n`;

      const p = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: prompt + "\n\n[FASE: ANALISI SEZIONE]\n" + sectionHeader },
          { role: "user", content: chunks[i] },
        ],
      });

      partialAnalyses.push(p.choices?.[0]?.message?.content?.trim() || "");
    }

    const synthesisUser =
      `DATI:\n` +
      `Titolo: ${projectTitle || "Titolo mancante"}\n` +
      `Autore: ${projectAuthor || "Autore mancante"}\n\n` +
      `ANALISI PARZIALI:\n` +
      partialAnalyses.join("\n\n--- SEZIONE ---\n\n");

    const final = await openai.chat.completions.create({
      model: AI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: prompt + "\n\n[FASE: SINTESI FINALE]" },
        { role: "user", content: synthesisUser },
      ],
    });

    const finalText = final.choices?.[0]?.message?.content?.trim() || "Errore nella valutazione finale.";
    const fixedText = applyTypographicFixes(finalText);

    // archivio server
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

    return fixedText;
  }

  // Helper: se arriva testo puro ma serve HTML, lo convertiamo in <p>
  function ensureHtmlParagraphs(s) {
    if (looksLikeDocxHtml(s)) return s;
    const paragraphs = String(s || "")
      .split(/\r?\n\s*\r?\n|\r?\n{2,}/)
      .map((x) => x.trim())
      .filter(Boolean);
    return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
  }

  // --- 2) EDITING ORIGINALE (DOCX) ---
  if (modeEffective === "editing-originale") {
    const systemPrompt = readPromptFile("editing-originale.txt");
    if (!systemPrompt.trim()) throw new Error("Prompt editing-originale.txt mancante o vuoto");

    const htmlEffective = ensureHtmlParagraphs(textEffective);
    const { out, meta } = await runDocxParagraphPipeline({
      openaiClient: openai,
      systemPrompt,
      htmlEffective,
      modeLabel: "EDITING_ORIGINALE",
    });

    return { result: out, meta };
  }

  // --- 3) RISCRITTURA-TRADUZIONE (DOCX) ---
  if (modeEffective === "riscrittura-traduzione") {
    const systemPrompt = readPromptFile("riscrittura-traduzione.txt");
    if (!systemPrompt.trim()) throw new Error("Prompt riscrittura-traduzione.txt mancante o vuoto");

    const htmlEffective = ensureHtmlParagraphs(textEffective);
    const { out, meta } = await runDocxParagraphPipeline({
      openaiClient: openai,
      systemPrompt,
      htmlEffective,
      modeLabel: "RISCRITTURA_TRADUZIONE",
    });

    return { result: out, meta };
  }

  // --- 4) TRADUZIONE IT->EN (testo lungo) ---
  if (modeEffective === "traduzione-it-en") {
    const prompt = readPromptFile("traduzione-it-en.txt");
    if (!prompt.trim()) throw new Error("Prompt traduzione-it-en.txt mancante o vuoto");

    const chunks = chunkText(textEffective, 80000);
    console.log("TRADUZIONE IT-EN: chunks:", chunks.length);

    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: chunks[i] },
        ],
      });
      out.push(c.choices?.[0]?.message?.content?.trim() || "");
    }
    return out.join("\n\n");
  }

  throw new Error(`Mode non supportata: ${modeEffective || "(mancante)"}`);
}

// ===============================
// API AI PRINCIPALE (opzionale, compat)
// ===============================
app.post("/api/ai", async (req, res) => {
  try {
    const result = await runAiCore(req.body || {});
    return res.json({ success: true, result });
  } catch (err) {
    console.error("Errore /api/ai:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// ===============================
// AVVIO SERVER
// ===============================
async function main() {
  await initRedis();

  app.listen(PORT, () => {
    console.log("🚀 Fermento AI backend in ascolto su", PORT);
  });
}

main().catch((e) => {
  console.error("❌ Fatal startup error:", e?.message || e);
  process.exit(1);
});
