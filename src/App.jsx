import { useState, useEffect } from "react";
import "./App.css";

const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const API_BASE = isLocalHost
  ? "http://localhost:3001"
  : "https://fermento-editor.onrender.com";

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

  const projectId = "default-project";

  // ===========================
  // CARICAMENTO VALUTAZIONI
  // ===========================
  useEffect(() => {
    loadEvaluations();
  }, []);

  async function loadEvaluations() {
    try {
      setIsLoadingEvals(true);
      const res = await fetch(
        `${API_BASE}/api/evaluations?projectId=${encodeURIComponent(projectId)}`
      );
      const data = await res.json();
      const list = Array.isArray(data.evaluations) ? data.evaluations : [];
      setEvaluations(list);
    } catch (err) {
      console.error("Errore caricamento valutazioni:", err);
    } finally {
      setIsLoadingEvals(false);
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
  // SALVATAGGIO / CANCELLAZIONE VALUTAZIONI
  // ===========================
  async function saveCurrentEvaluation() {
    if (!currentEvaluation.trim()) {
      alert("Non c'è nessun testo di valutazione da salvare.");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/evaluations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          fileName: null,
          title: "Valutazione " + new Date().toLocaleString(),
          evaluationText: currentEvaluation,
          meta: {},
        }),
      });

      const data = await res.json();
      if (data && data.success && data.evaluation) {
        setEvaluations((prev) => [...prev, data.evaluation]);
      } else {
        alert("Risposta inattesa dal server.");
      }
    } catch (err) {
      console.error("Errore salvataggio valutazione:", err);
      alert("Errore nel salvataggio della valutazione.");
    }
  }

  async function deleteEvaluation(id) {
    if (!window.confirm("Vuoi davvero cancellare questa valutazione?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/evaluations/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();

      if (!data.success) {
        alert("Errore nella cancellazione della valutazione.");
        return;
      }

      setEvaluations((prev) => prev.filter((v) => v.id !== id));
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
  // CHIAMATA AI
  // ===========================
  async function callAi(mode) {
    if (!inputText.trim()) {
      alert("Inserisci o carica del testo nella colonna di sinistra.");
      return;
    }

    setIsAiLoading(true);
    setLastAiMode(mode);

    try {
      const res = await fetch(`${API_BASE}/api/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          text: inputText,
          projectTitle,
          projectAuthor,
        }),
      });

      if (!res.ok) {
        console.error(await res.text());
        alert("Errore nella chiamata all'AI.");
        return;
      }

      const data = await res.json();

      if (mode === "valutazione-manoscritto") {
        setCurrentEvaluation(data.result || "");
      } else {
        setOutputText(data.result || "");
      }
    } catch (err) {
      console.error("Errore chiamata AI:", err);
      alert("Errore di rete nella chiamata AI.");
    } finally {
      setIsAiLoading(false);
    }
  }

  // ===========================
  // EXPORT DOCX
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
        console.error(await res.text());
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
          <h2>Testo originale</h2>

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
          <h2>Risultato AI</h2>

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

          <h3 style={{ marginTop: "10px" }}>Valutazione corrente</h3>
          <textarea
            value={currentEvaluation}
            onChange={(e) => setCurrentEvaluation(e.target.value)}
          />

          <div className="buttons-row">
            <button onClick={saveCurrentEvaluation}>
              Salva valutazione
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
                    {new Date(v.createdAt).toLocaleString()}
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
