import { useState, useEffect } from "react";
import "./App.css";

const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const API_BASE = isLocalHost
  ? "http://localhost:3001"
  : "https://fermento-editor.onrender.com";

const EVAL_STORAGE_KEY = "fermento-editor-evaluations-v1";

function App() {
  // ===========================
  // STATI BASE
  // ===========================
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");

  const [currentEvaluation, setCurrentEvaluation] = useState("");
  const [evaluations, setEvaluations] = useState([]);
  const [isLoadingEvals, setIsLoadingEvals] = useState(false);

  const [projectTitle, setProjectTitle] = useState("");
  const [projectAuthor, setProjectAuthor] = useState("");

  const [isAiLoading, setIsAiLoading] = useState(false);
  const [lastAiMode, setLastAiMode] = useState(null);

  // ✅ nuovo: preferenza se l’editing deve usare la valutazione
  const [useEvalForEditing, setUseEvalForEditing] = useState(false);

  // ===========================
  // CARICAMENTO VALUTAZIONI (localStorage)
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
      if (Array.isArray(parsed)) {
        setEvaluations(parsed);
      } else {
        setEvaluations([]);
      }
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

  // ===========================
  // UPLOAD FILE
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

      const data = await res.json();
      if (!data.success) {
        alert(data.error || "Errore import file.");
        return;
      }

      setInputText(data.text || "");
    } catch (err) {
      console.error("Errore upload file:", err);
      alert("Errore durante l'upload del file.");
    } finally {
      e.target.value = "";
    }
  }

  // ===========================
  // SALVATAGGIO / CANCELLAZIONE VALUTAZIONI (solo localStorage)
  // ===========================
  function saveCurrentEvaluation() {
    if (!currentEvaluation.trim()) {
      alert("Non c'è nessun testo di valutazione da salvare.");
      return;
    }

    try {
      const now = new Date();

      const titleFromProject =
        projectTitle && projectTitle.trim().length > 0
          ? projectTitle.trim()
          : null;

      const title =
        titleFromProject || "Valutazione " + now.toLocaleString();

      const item = {
        id: window.crypto?.randomUUID
          ? window.crypto.randomUUID()
          : Date.now().toString(),
        title,
        projectTitle: projectTitle || "",
        projectAuthor: projectAuthor || "",
        evaluationText: currentEvaluation,
        createdAt: now.toISOString(),
      };

      const updated = [...evaluations, item];
      persistEvaluations(updated);

      alert("Valutazione salvata correttamente!");
    } catch (err) {
      console.error("Errore salvataggio valutazione:", err);
      alert("Errore nel salvataggio della valutazione.");
    }
  }

  function deleteEvaluation(id) {
    if (!window.confirm("Vuoi davvero cancellare questa valutazione?")) return;

    try {
      const updated = evaluations.filter((v) => v.id !== id);
      persistEvaluations(updated);
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
  // CHIAMATA AI (VERSIONE UNIVERSALE)
  // ===========================
  async function callAi(mode) {
    if (!inputText.trim()) {
      alert("Inserisci o carica del testo nella colonna di sinistra.");
      return;
    }

    setIsAiLoading(true);
    setLastAiMode(mode);

    try {
      // base del body
      const body = {
        mode,
        text: inputText,
        projectTitle,
        projectAuthor,
      };

      // se stiamo facendo editing/correzione, passiamo anche la valutazione
      const isEditingMode =
        mode === "correzione-soft" ||
        mode === "editing-leggero" ||
        mode === "editing-moderato" ||
        mode === "editing-profondo" ||
        mode === "traduzione-it-en";

      if (isEditingMode) {
        body.useEvaluationForEditing = useEvalForEditing;
        body.currentEvaluation = useEvalForEditing
          ? currentEvaluation || ""
          : "";
      }

      const res = await fetch(`${API_BASE}/api/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let errorText = "";
        try {
          errorText = await res.text();
        } catch (readErr) {
          console.error("Errore leggendo risposta:", readErr);
        }

        const message =
          errorText && errorText.trim().length > 0
            ? errorText
            : `${res.status} ${res.statusText}`;

        alert("Errore AI: " + message);
        return;
      }

      const data = await res.json();
      console.log("Risposta AI dal backend:", data);

      let output =
        data.result ||
        data.outputText ||
        data.text ||
        data.output ||
        (data.choices &&
          data.choices[0] &&
          data.choices[0].message &&
          data.choices[0].message.content);

      if (!output) {
        output = JSON.stringify(data, null, 2);
      }

      // 🔴 QUI RISOLVIAMO IL PROBLEMA:
      // - se è una VALUTAZIONE, scriviamo nella colonna DESTRA
      // - altrimenti nella colonna CENTRALE
      if (mode === "valutazione-manoscritto") {
        setCurrentEvaluation(output);
        // opzionale: pulisco il centro per evitare confusione
        // setOutputText("");
      } else {
        setOutputText(output);
      }
    } catch (err) {
      console.error("Errore chiamata AI:", err);
      alert("Errore nella chiamata AI: " + err.message);
    } finally {
      setIsAiLoading(false);
    }
  }

  // ===========================
  // EXPORT DOCX TESTO
  // ===========================
  async function handleExportDocx() {
    const textToExport =
      (outputText && outputText.trim()) || inputText.trim();

    if (!textToExport) {
      alert("Non c'è nessun testo da esportare.");
      return;
    }

    const rawParagraphs = textToExport
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const htmlParagraphs = rawParagraphs
      .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
      .join("\n");

    try {
      const res = await fetch(`${API_BASE}/api/export-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: htmlParagraphs }),
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error("Errore export-docx:", txt);
        alert("Errore durante l'esportazione in DOCX.");
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
  // La valutazione è già HTML (con <h2>, <h3>, <p>, <ul>, <li>...)
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
      <span className="char-counter">
        Caratteri: {inputText ? inputText.length : 0}
      </span>
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
            <button
              onClick={() => callAi("correzione-soft")}
              disabled={isAiLoading}
            >
              {isAiLoading && lastAiMode === "correzione-soft"
                ? "AI: correzione..."
                : "Correzione testo"}
            </button>

            <button
              onClick={() => callAi("editing-leggero")}
              disabled={isAiLoading}
            >
              Editing leggero
            </button>

            <button
              onClick={() => callAi("editing-moderato")}
              disabled={isAiLoading}
            >
              Editing moderato
            </button>

            <button
              onClick={() => callAi("editing-profondo")}
              disabled={isAiLoading}
            >
              Editing profondo
            </button>

            <button
              onClick={() => callAi("traduzione-it-en")}
              disabled={isAiLoading}
            >
              Traduzione IT → EN
            </button>
          </div>
        </section>

       {/* COLONNA CENTRALE */}
<section className="column">
  <div className="pane-header">
    <h2>Risultato AI</h2>
    <span className="char-counter">
      Caratteri: {outputText ? outputText.length : 0}
    </span>
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

          <button
            onClick={() => callAi("valutazione-manoscritto")}
            disabled={isAiLoading}
          >
            Valutazione manoscritto
          </button>

          {/* ✅ SCELTA: EDITING BASATO O NO SULLA VALUTAZIONE */}
          <div
            className="buttons-row"
            style={{ marginTop: "8px", marginBottom: "4px" }}
          >
            <button
              onClick={() => setUseEvalForEditing(true)}
              style={{
                padding: "4px 8px",
                borderRadius: "6px",
                border: "none",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: useEvalForEditing ? "#e67e22" : "#bdc3c7",
                color: "white",
              }}
            >
              Editing basato su valutazione
            </button>
            <button
              onClick={() => setUseEvalForEditing(false)}
              style={{
                padding: "4px 8px",
                borderRadius: "6px",
                border: "none",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: !useEvalForEditing ? "#2c3e50" : "#bdc3c7",
                color: "white",
              }}
            >
              Editing senza valutazione
            </button>
          </div>

          <h3 style={{ marginTop: "10px" }}>Valutazione corrente</h3>
          <textarea
            value={currentEvaluation}
            onChange={(e) => setCurrentEvaluation(e.target.value)}
          />

          <div className="buttons-row">
            <button onClick={saveCurrentEvaluation}>
              Salva valutazione
            </button>
            <button onClick={handleExportEvaluationDocx}>
              Esporta valutazione DOCX
            </button>
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
                  <strong>
                    {v.title || v.projectTitle || "Valutazione"}
                  </strong>
                  <span className="eval-date">
                    {v.createdAt
                      ? new Date(v.createdAt).toLocaleString()
                      : ""}
                  </span>
                </div>

                <div className="eval-actions">
                  <button onClick={() => recallEvaluation(v)}>
                    Richiama
                  </button>
                  <button onClick={() => deleteEvaluation(v.id)}>
                    Elimina
                  </button>
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
