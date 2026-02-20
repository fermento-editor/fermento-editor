// server/index.js — FERMENTO EDITOR BACKEND (SEMPLIFICATO, STABILE)
// SINGLE SOURCE OF TRUTH: Redis JOB
// MODE SUPPORTATE:
// - valutazione
// - editing-originale
// - traduzione-riscrittura
// MODELLO UNICO: gpt-5.2

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
import { applyTypography } from "./typography/applyTypography.js";
dotenv.config();

// ===============================
// COSTANTI
// ===============================
const AI_MODEL = "gpt-5.2";
const JOB_TTL_SECONDS = 60 * 60;
const PORT = process.env.PORT || 3001;

// ===============================
// OPENAI
// ===============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===============================
// APP
// ===============================
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, _res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});

// ===============================
// PATH
// ===============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

// ===============================
// UPLOAD DOCX -> HTML (per frontend)
// ===============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Nessun file ricevuto (field: file)" });
    }

    const filePath = req.file.path;

    // DOCX -> HTML
    const result = await mammoth.convertToHtml({ path: filePath });
    const html = String(result.value || "");

    // pulizia file temporaneo
    try { await fsPromises.unlink(filePath); } catch (_) {}

    return res.json({ success: true, html });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ success: false, error: e.message || "Upload failed" });
  }
});

// ===============================
// EXPORT HTML -> DOCX
// ===============================
app.post("/api/export-docx", async (req, res) => {
  try {
    const { html } = req.body || {};

    if (!html || typeof html !== "string") {
      return res.status(400).json({ success: false, error: "html mancante nel body" });
    }

    const wrappedHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>${html}</body>
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

    const wrappedHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>${html}</body>
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
    return res.status(500).json({ success: false, error: "Errore conversione DOCX preserve" });
  }
});


const promptsDir = path.join(__dirname, "prompts");
const dataDir = path.join(__dirname, "data");

// ===============================
// REDIS
// ===============================
let redis = null;
async function initRedis() {
  try {
    const mod = await import("./redis.js");
    redis = mod.redis || null;
    if (redis) {
      await redis.ping();
      console.log("✅ Redis connesso");
    }
  } catch (e) {
    console.error("❌ Redis error:", e);
    redis = null;
  }
}

// ===============================
// UTILS
// ===============================
function readPromptFile(name) {
  return fs.readFileSync(path.join(promptsDir, name), "utf8");
}

function chunkText(text, size = 80000) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function looksLikeDocxHtml(t) {
  return typeof t === "string" && /<p\b/i.test(t);
}

function extractParagraphs(html) {
  return html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
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


function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
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
function isChapterTitleParagraph(pHtml) {
  const text = stripTagsToText(pHtml);
  if (!text) return false;
  return /^capitolo\b/i.test(text);
}


function normalizeAiParagraph(p) {
  const s = String(p || "").trim();
  const m = s.match(/<p\b[^>]*>[\s\S]*<\/p>/i);
  const oneP = m ? m[0] : `<p>${s}</p>`;
  return applyTypography(oneP);
}

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
// REDIS JOB UTILS
// ===============================
async function setJob(jobId, data) {
  await redis.hset(`job:${jobId}`, data);
  await redis.expire(`job:${jobId}`, JOB_TTL_SECONDS);
}

async function getJob(jobId) {
  const d = await redis.hgetall(`job:${jobId}`);
  return Object.keys(d).length ? d : null;
}

// ===============================
// JOB PROCESSOR
// ===============================
async function processJob(jobId) {
  try {
    await setJob(jobId, { status: "running", progress: "0.1" });
    const payload = JSON.parse(await redis.get(`job:${jobId}:payload`));
    const result = await runAiCore(payload);
    await redis.set(
      `job:${jobId}:result`,
      JSON.stringify(result),
      "EX",
      JOB_TTL_SECONDS
    );
    await setJob(jobId, { status: "done", progress: "1" });
  } catch (e) {
    await setJob(jobId, { status: "error", error: e.message });
  }
}

// ===============================
// AI CORE
// ===============================
async function runAiCore(body) {
  const {
    mode,
    text = "",
    html = "",
    projectTitle = "",
    projectAuthor = "",
  } = body;

     // ---- NORMALIZZAZIONE MODE (compatibilità frontend) ----
  let modeEffective = mode;

  // alias EDITING (frontend storico)
  if (
    modeEffective === "editing" ||
    modeEffective === "editing-fermento" ||
    modeEffective === "editing-default"
  ) {
    modeEffective = "editing-originale";
  }

  // alias RISCRITTURA/TRADUZIONE (frontend)
  if (
    modeEffective === "traduzione" ||
    modeEffective === "traduzione-riscrittura-fermento" ||
    modeEffective === "traduzione-riscrittura" ||
    modeEffective === "riscrittura-traduzione"
  ) {
    modeEffective = "riscrittura-traduzione";
  }


  const textEffective = html || text || "";

  // -------- VALUTAZIONE --------
  if (modeEffective === "valutazione") { 
    const prompt = readPromptFile("valutazione-fermento.txt");
    const chunks = chunkText(textEffective);
    const out = [];

    for (const c of chunks) {
      const r = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: c },
        ],
      });
      out.push(r.choices[0].message.content);
    }
    return out.join("\n\n");
  }

  // -------- EDITING ORIGINALE --------
  if (modeEffective === "editing-originale") {
    const systemPrompt = readPromptFile("editing-originale.txt");

    let htmlEffective = textEffective;
    if (!looksLikeDocxHtml(htmlEffective)) {
      throw new Error("Editing supportato solo su HTML DOCX");
    }

    const paragraphs = extractParagraphs(htmlEffective);
    const output = new Array(paragraphs.length);

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (!stripTags(p)) {
        output[i] = "<p></p>";
        continue;
      }

      const r = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: p },
        ],
      });

      output[i] = normalizeAiParagraph(r.choices[0].message.content);
    }

    return output.join("\n");
  }
 // -------- TRADUZIONE IT -> EN (testo lungo) --------
  if (modeEffective === "traduzione-it-en") {
    const prompt = readPromptFile("traduzione-it-en.txt");
    if (!prompt || !prompt.trim()) {
      throw new Error("Prompt traduzione-it-en.txt mancante o vuoto");
    }

    // Se arriva HTML, lo “spoglio” in testo per evitare che traduca tag
    let textForTranslation = String(textEffective || "");
    if (looksLikeDocxHtml(textForTranslation)) {
      textForTranslation = textForTranslation.replace(/<[^>]+>/g, " ");
      textForTranslation = textForTranslation.replace(/\s+/g, " ").trim();
    }

    const chunks = chunkText(textForTranslation, 80000);
    const out = [];

    for (let i = 0; i < chunks.length; i++) {
      const r = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: chunks[i] },
        ],
      });

      out.push(r.choices?.[0]?.message?.content?.trim() || "");
    }

    return out.join("\n\n");
  }
      // -------- RISCRITTURA / TRADUZIONE (DOCX grandi OK via pipeline 600K) --------
  if (modeEffective === "riscrittura-traduzione") {

     
    const systemPrompt = readPromptFile("riscrittura-traduzione.txt");
    if (!systemPrompt || !systemPrompt.trim()) {
      throw new Error("Prompt riscrittura-traduzione.txt mancante o vuoto");
    }

    // qui deve arrivare HTML DOCX (con <p>...</p>)
    let htmlEffective = textEffective;
    if (!looksLikeDocxHtml(htmlEffective)) {
      throw new Error("Riscrittura-traduzione supportata solo su HTML DOCX");
    }

    const { out } = await runDocxParagraphPipeline({
      openaiClient: openai,
      systemPrompt,
      htmlEffective,
      modeLabel: "RISCRITTURA_TRADUZIONE",
    });

    return out;
  }



  throw new Error("Mode non supportata");
}

// ===============================
// JOB API
// ===============================
app.post("/api/ai-job/start", async (req, res) => {
  if (!redis) return res.status(500).json({ success: false });
  const jobId = uuidv4();
  await setJob(jobId, { status: "queued", progress: "0" });
  await redis.set(
    `job:${jobId}:payload`,
    JSON.stringify(req.body),
    "EX",
    JOB_TTL_SECONDS
  );
  setImmediate(() => processJob(jobId));
  res.json({ success: true, jobId });
});

app.get("/api/ai-job/status", async (req, res) => {
  const job = await getJob(req.query.jobId);
  if (!job) return res.status(404).json({ success: false });
  res.json({ success: true, ...job });
});

app.get("/api/ai-job/result", async (req, res) => {
  const raw = await redis.get(`job:${req.query.jobId}:result`);
  if (!raw) return res.status(404).json({ success: false });
  res.json({ success: true, result: JSON.parse(raw) });
});

// ===============================
// START
// ===============================
async function main() {
  await initRedis();
  app.listen(PORT, () => {
    console.log("🚀 FERMENTO BACKEND AVVIATO SU", PORT);
  });
}

main();
