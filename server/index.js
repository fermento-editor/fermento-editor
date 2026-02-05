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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function normalizeAiParagraph(p) {
  const s = String(p || "").trim();
  const m = s.match(/<p\b[^>]*>[\s\S]*<\/p>/i);
  return m ? m[0] : `<p>${s}</p>`;
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

  // alias TRADUZIONE
  if (
    modeEffective === "traduzione" ||
    modeEffective === "traduzione-riscrittura-fermento"
  ) {
    modeEffective = "traduzione-riscrittura";
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

  // -------- TRADUZIONE / RISCRITTURA --------
  if (modeEffective === "traduzione-riscrittura") {
    const prompt = readPromptFile("traduzione-riscrittura.txt");
    const r = await openai.chat.completions.create({
      model: AI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: textEffective },
      ],
    });
    return r.choices[0].message.content;
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
