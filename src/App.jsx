import { useState, useEffect } from "react";
import "./App.css";

const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const API_BASE = isLocalHost
  ? "http://localhost:3001"
  : "https://fermento-editor-backed.onrender.com";

const EVAL_STORAGE_KEY = "fermento-editor-evaluations-v1";

function App() {
  // ===========================
  // STATI BASE
  // ===========================
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");

  const [inputHtml, setInputHtml] = useState("");   // HTML originale da DOCX
  const [outputHtml, setOutputHtml] = useState(""); // HTML editato dall’AI
  const [uploadedDocxFile, setUploadedDocxFile] = useState(null); // file DOCX originale caricato

  const [currentEvaluation, setCurrentEvaluation] = useState("");
  const [evaluations, setEvaluations] = useState([]);
  const [isLoadingEvals, setIsLoadingEvals] = useState(false);

  const [projectTitle, setProjectTitle] = useState("");
  const [projectAuthor, setProjectAuthor] = useState("");

  const [isAiLoading, setIsAiLoading] = useState(false);
  const [lastAiMode, setLastAiMode] = useState(null);

  // ===========================
  // UTILS
  // ===========================
  function stripHtmlToText(html) {
    if (!html) return "";
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<\/?p[^>]*>/gi, "")
      .replace(/<\/?(strong|em|u|h1|h2|h3|h4|h5|h6)[^>]*>/gi, "")
      .replace(/<\/?li[^>]*>/gi, "\n- ")
      .replace(/<\/?(ul|ol)[^>]*>/gi, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  }

  function escapeHtml(s) {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function textToHtmlRich(text) {
    const t = (text || "").trim();
    if (!t) return "";

    const lines = t.replace(/\r\n/g, "\n").split("\n");
    let out = [];
    let inList = false;

    const applyInline = (s) => {
      let x = escapeHtml(s);
      x = x.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      x = x.replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1<em>$2</em>");
      return x;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();

      if (!line) {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        continue;
      }

      if (/^-\s+/.test(line)) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        const item = line.replace(/^-\s+/, "");
        out.push(`<li>${applyInline(item)}</li>`);
        continue;
      }

      if (inList) {
        out.push("</ul>");
        inList = false;
      }

      out.push(`<p>${applyInline(line)}</p>`);
    }

    if (inList) out.push("</ul>");
    return out.join("\n");
  }

  // ===========================
  // VALUTAZIONI (localStorage)
  // ===========================
  useEffect(() => {
    loadEvaluations();
  }, []);

  function loadEvaluations() {
    try {
      setIsLoadingEvals(true);
      const raw = window.localStorage.getItem(EVAL_STORAGE_KEY);
      if (!raw) {
        setEvaluations([]);
        return;
      }
      const parsed = JSON.parse(raw);
      setEvaluations(Array.isArray(parsed) ? parsed : []);
    } catch (err) {
      console.error("Errore caricamento valutazioni:", err);
      setEvaluations([]);
    } finally {
      setIsLoadingEvals(false);
    }
  }

  function persistEvaluations(list) {
    setEvaluations(list);
    try {
      window.localStorage.setItem(EVAL_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.error("Errore salvataggio valutazioni in localStorage:", err);
    }
  }

  function saveCurrentEvaluation() {
    if (!currentEvaluation.trim()) {
      alert("Non c'è nessun testo di valutazione da salvare.");
      return;
    }

    try {
      const now = new Date();
      const title =
        (projectTitle && projectTitle.trim()) || "Valutazione " + now.toLocaleString();

      const item = {
        id: window.crypto?.randomUUID ? window.crypto.randomUUID() : Date.now().toString(),
        title,
        projectTitle: projectTitle || "",
        projectAuthor: projectAuthor || "",
        evaluationText: currentEvaluation,
        createdAt: now.toISOString(),
      };

      persistEvaluations([...evaluations, item]);
      alert("Valutazione salvata correttamente!");
    } catch (err) {
      console.error("Errore salvataggio valutazione:", err);
      alert("Errore nel salvataggio della valutazione.");
    }
  }

  function deleteEvaluation(id) {
    if (!window.confirm("Vuoi davvero cancellare questa valutazione?")) return;
    try {
      persistEvaluations(evaluations.filter((v) => v.id !== id));
    } catch (err) {
      console.error("Errore cancellazione valutazione:", err);
      alert("Errore nella cancellazione della valutazione.");
    }
  }

  function recallEvaluation(evalObj) {
    const text = evalObj.evaluationText || evalObj.html || "";
    setCurrentEvaluation(text);
  }

  // ===========================
  // UPLOAD FILE (DOCX/PDF)
  // ===========================
  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        alert(data.error || "Errore import file.");
        return;
      }

      // ✅ backend ora può restituire html oppure text (per docx)
      const importedHtml = (data.html || data.text || "").trim();
      const isDocx = data.type === "docx" || !!data.html || (typeof importedHtml === "string" && /<p\b/i.test(importedHtml));

      if (isDocx) {
        setUploadedDocxFile(file);
        setInputHtml(importedHtml);
        setInputText(stripHtmlToText(importedHtml));
        setOutputHtml("");
        setOutputText("");
      } else {
        // pdf/testo
        setUploadedDocxFile(null);
        setInputHtml("");
        setInputText(String(data.text || importedHtml || ""));
        setOutputHtml("");
        setOutputText("");
      }
    } catch (err) {
      console.error("Errore upload file:", err);
      alert("Errore durante l'upload del file.");
    } finally {
      e.target.value = "";
    }
  }

  // ===========================
  // JOB CALL AI (unica)
  // ===========================
  async function callAi(mode) {
    // regola: editing-originale e riscrittura-traduzione lavorano su HTML se presente
    const needsDocxHtml = mode === "editing-originale" || mode === "riscrittura-traduzione";

    if (needsDocxHtml) {
      if (!inputHtml || !inputHtml.trim()) {
        alert("Per questa operazione devi caricare un DOCX (serve l'HTML con <p>...</p>).");
        return;
      }
    } else {
      if (!inputText.trim()) {
        alert("Inserisci o carica del testo nella colonna di sinistra.");
        return;
      }
    }

    setIsAiLoading(true);
    setLastAiMode(mode);

    try {
      const body = {
        mode,
        projectTitle,
        projectAuthor,
        // per le modalità DOCX: manda html
        ...(needsDocxHtml ? { html: inputHtml } : { text: inputText }),
      };

      const startRes = await fetch(`${API_BASE}/api/ai-job/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData?.success || !startData?.jobId) {
        const msg = startData?.error || `${startRes.status} ${startRes.statusText}` || "Errore start job";
        alert("Errore AI: " + msg);
        return;
      }

      const jobId = startData.jobId;

      let status = "running";
      let lastError = "";
      let netErrors = 0;

      for (let attempts = 0; attempts < 1200; attempts++) {
        await new Promise((r) => setTimeout(r, 3000));

        try {
          const stRes = await fetch(
            `${API_BASE}/api/ai-job/status?jobId=${encodeURIComponent(jobId)}`,
            { cache: "no-store" }
          );

          const stData = await stRes.json().catch(() => ({}));
          if (!stRes.ok || !stData?.success) {
            netErrors++;
            if (netErrors >= 10) {
              const msg = stData?.error || `${stRes.status} ${stRes.statusText}` || "Errore status job (ripetuto)";
              alert("Errore AI: " + msg);
              return;
            }
            continue;
          }

          netErrors = 0;
          status = stData.status || "running";
          lastError = stData.error || "";

          if (status === "error") {
            alert("Errore AI: " + (lastError || "Job in errore"));
            return;
          }

          if (status === "done") break;
        } catch (e) {
          netErrors++;
          if (netErrors >= 10) {
            alert("Errore AI: rete instabile (fetch failed ripetuto). Riprova.");
            return;
          }
          continue;
        }
      }

      if (status !== "done") {
        alert("Errore AI: timeout job (non completato).");
        return;
      }

      const outRes = await fetch(
        `${API_BASE}/api/ai-job/result?jobId=${encodeURIComponent(jobId)}`,
        { cache: "no-store" }
      );

      const outData = await outRes.json().catch(() => ({}));
      if (!outRes.ok || !outData?.success) {
        const msg = outData?.error || `${outRes.status} ${outRes.statusText}` || "Errore result job";
        alert("Errore AI: " + msg);
        return;
      }

      // outData.result può essere stringa o oggetto {result, meta}
      const payload = outData.result;

      // valutazione
      if (mode === "valutazione") {
        const evalText = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
        setCurrentEvaluation(evalText);
        return;
      }

      // altre modalità
      let output = "";
      if (typeof payload === "string") output = payload;
      else if (payload && typeof payload === "object") output = payload.result || JSON.stringify(payload, null, 2);
      else output = String(payload || "");

      setOutputText(output);

      const isHtml = /<\/?(p|strong|em|ul|ol|li|h2|h3|br)\b/i.test(output);
      if (isHtml) setOutputHtml(output);
      else setOutputHtml(textToHtmlRich(output));
    } catch (err) {
      console.error("Errore chiamata AI:", err);
      alert("Errore nella chiamata AI: " + (err?.message || String(err)));
    } finally {
      setIsAiLoading(false);
    }
  }

  // ===========================
  // EXPORT DOCX (smart)
  // ===========================
  async function handleExportDocx() {
    // 1) cosa esportare
    let htmlToExport = "";

    if (outputHtml && outputHtml.trim()) htmlToExport = outputHtml.trim();
    else if (inputHtml && inputHtml.trim()) htmlToExport = inputHtml.trim();
    else {
      const textToExport = (outputText && outputText.trim()) || inputText.trim();
      if (!textToExport) {
        alert("Non c'è nessun testo da esportare.");
        return;
      }
      htmlToExport = textToHtmlRich(textToExport);
    }

    // 2) pulizia eventuali sezioni tecniche
    htmlToExport = htmlToExport
      .replace(/(\*\*)?\s*Sezione\s+\d+\s*\/\s*\d+\s*-\s*[^<\n]+(\*\*)?/gi, "")
      .replace(/<p>\s*(\*\*)?\s*Sezione\s+\d+\s*\/\s*\d+\s*-\s*[^<]+(\*\*)?\s*<\/p>/gi, "")
      .trim();

    try {
      // ✅ Se ho un DOCX caricato, uso preserve (come volevi tu).
      if (uploadedDocxFile) {
        const fd = new FormData();
        fd.append("file", uploadedDocxFile);
        fd.append("html", htmlToExport);

        const res = await fetch(`${API_BASE}/api/docx/editing-preserve`, {
          method: "POST",
          body: fd,
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          console.error("Errore editing-preserve:", txt);
          alert("Errore durante l'esportazione DOCX (preserva).");
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "fermento-document.docx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }

      // ✅ Fallback: export semplice se non ho docx (non blocca mai)
      const res = await fetch(`${API_BASE}/api/export-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: htmlToExport }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error("Errore export-docx:", txt);
        alert("Errore durante l'esportazione DOCX.");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "fermento-document.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Errore network export DOCX:", err);
      alert("Errore di rete durante l'esportazione in DOCX.");
    }
  }

  // ===========================
  // EXPORT DOCX VALUTAZIONE
  // ===========================
  async function handleExportEvaluationDocx() {
    const htmlToExport = currentEvaluation.trim();
    if (!htmlToExport) {
      alert("Non c'è nessuna valutazione da esportare.");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/export-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: htmlToExport }),
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error("Errore export-docx valutazione:", txt);
        alert("Errore durante l'esportazione della valutazione in DOCX.");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "valutazione-manoscritto.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Errore network export valutazione DOCX:", err);
      alert("Errore di rete durante l'esportazione della valutazione.");
    }
  }

  // ===========================
  // RENDER
  // ===========================
  return (
    <div className="App">
      <header className="topbar">
        <h1>Fermento Editor</h1>
      </header>

      <main className="layout">
        {/* COLONNA SINISTRA */}
        <section className="column">
          <div className="pane-header">
            <h2>Testo originale</h2>
            <span className="char-counter">Caratteri: {inputText ? inputText.length : 0}</span>
          </div>

          <input
            type="file"
            accept=".docx,.pdf"
            onChange={handleFileUpload}
            style={{ marginBottom: "8px" }}
          />

          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Incolla qui il testo o caricalo da file..."
          />

          <div className="buttons-row">
            <button onClick={() => callAi("editing-originale")} disabled={isAiLoading}>
              {isAiLoading && lastAiMode === "editing-originale" ? "AI: editing..." : "Editing originale (DOCX)"}
            </button>

            <button onClick={() => callAi("riscrittura-traduzione")} disabled={isAiLoading}>
              {isAiLoading && lastAiMode === "riscrittura-traduzione" ? "AI: riscrittura..." : "Riscrittura-traduzione (DOCX)"}
            </button>

            <button onClick={() => callAi("traduzione-it-en")} disabled={isAiLoading}>
              {isAiLoading && lastAiMode === "traduzione-it-en" ? "AI: traduzione..." : "Traduzione IT → EN"}
            </button>
          </div>
        </section>

        {/* COLONNA CENTRALE */}
        <section className="column">
          <div className="pane-header">
            <h2>Risultato AI</h2>
            <span className="char-counter">Caratteri: {outputText ? outputText.length : 0}</span>
          </div>

          <textarea
            value={outputText}
            onChange={(e) => setOutputText(e.target.value)}
            placeholder="Qui apparirà l'output dell'AI."
          />

          <div className="buttons-row" style={{ marginTop: "8px" }}>
            <button onClick={handleExportDocx}>Scarica DOCX</button>
          </div>
        </section>

        {/* COLONNA DESTRA */}
        <section className="column">
          <h2>Valutazione manoscritto</h2>

          <div className="meta-fields">
            <input
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              placeholder="Titolo progetto"
            />
            <input
              type="text"
              value={projectAuthor}
              onChange={(e) => setProjectAuthor(e.target.value)}
              placeholder="Autore progetto"
            />
          </div>

          <button onClick={() => callAi("valutazione")} disabled={isAiLoading}>
            {isAiLoading && lastAiMode === "valutazione" ? "AI: valutazione..." : "Valutazione manoscritto"}
          </button>

          <h3 style={{ marginTop: "10px" }}>Valutazione corrente</h3>
          <textarea
            value={currentEvaluation}
            onChange={(e) => setCurrentEvaluation(e.target.value)}
          />

          <div className="buttons-row">
            <button onClick={saveCurrentEvaluation}>Salva valutazione</button>
            <button onClick={handleExportEvaluationDocx}>Esporta valutazione DOCX</button>
            <button onClick={loadEvaluations} disabled={isLoadingEvals}>
              {isLoadingEvals ? "Carico..." : "Aggiorna elenco"}
            </button>
          </div>

          <h3>Valutazioni salvate</h3>
          <div className="eval-list">
            {evaluations.length === 0 && (
              <p style={{ fontSize: "12px" }}>Nessuna valutazione salvata.</p>
            )}

            {evaluations.map((v) => (
              <div key={v.id} className="eval-item">
                <div className="eval-header">
                  <strong>{v.title || v.projectTitle || "Valutazione"}</strong>
                  <span className="eval-date">
                    {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}
                  </span>
                </div>

                <div className="eval-actions">
                  <button onClick={() => recallEvaluation(v)}>Richiama</button>
                  <button onClick={() => deleteEvaluation(v.id)}>Elimina</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
