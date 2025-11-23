import { useState } from "react";
import "./App.css";

// Conta parole e caratteri ignorando i tag HTML
function getStats(html) {
  const noTags = html.replace(/<[^>]+>/g, " ");
  const trimmed = noTags.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = html.length;
  return { words, chars };
}

// Spezza un HTML lungo in blocchi interi di <p>...</p> per il "libro intero"
function splitHtmlIntoChunks(html, maxChars = 40000) {
  if (!html || typeof html !== "string") return [];

  const paragraphRegex = /<p[\s\S]*?<\/p>/gi;
  const paragraphs = html.match(paragraphRegex);

  if (!paragraphs || paragraphs.length === 0) {
    const chunks = [];
    for (let i = 0; i < html.length; i += maxChars) {
      chunks.push(html.slice(i, i + maxChars));
    }
    return chunks;
  }

  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    if ((current + p).length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current += p;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

// Estrae solo il blocco della "Raccomandazione editoriale" dalla valutazione completa
function extractRecommendation(html) {
  if (!html || typeof html !== "string") return "";

  const lower = html.toLowerCase();
  const marker = "<h3>8. raccomandazione editoriale</h3>";

  const idx = lower.indexOf(marker);
  if (idx === -1) return "";

  const after = html.slice(idx + marker.length);
  const nextIdx = after.toLowerCase().indexOf("<h3>");

  const block = nextIdx === -1 ? after : after.slice(0, nextIdx);
  return block.trim();
}

function App() {
  const [originalHtml, setOriginalHtml] = useState(""); // HTML importato
  const [workedHtml, setWorkedHtml] = useState(""); // HTML lavorato / valutazione
  const [status, setStatus] = useState("Pronto.");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [lastAiMode, setLastAiMode] = useState(null);
  const [isBookProcessing, setIsBookProcessing] = useState(false);
  const [bookProgress, setBookProgress] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const [projectTitle, setProjectTitle] = useState("");
  const [projectAuthor, setProjectAuthor] = useState("");
  const [translationMode, setTranslationMode] = useState("none");

  // Valutazione manoscritto salvata (HTML completo)
  const [manuscriptEvaluation, setManuscriptEvaluation] = useState("");
  // Estratto della sola raccomandazione editoriale
  const [recommendationSummary, setRecommendationSummary] = useState("");

  // Elenco progetti salvati
  const [savedProjects, setSavedProjects] = useState([]);
  const [showProjects, setShowProjects] = useState(false);

  // Upload DOCX o PDF → backend → HTML
  const handleDocxUpload = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const name = file.name.toLowerCase();
    const isDocx = name.endsWith(".docx");
    const isPdf = name.endsWith(".pdf");

    if (!isDocx && !isPdf) {
      alert("Puoi caricare solo file Word (.docx) o PDF (.pdf).");
      event.target.value = "";
      return;
    }

    try {
      setIsUploading(true);
      setStatus(`Caricamento file "${file.name}" in corso...`);

      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("http://localhost:3001/api/upload-docx", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(
          "Errore dal server upload (status " + response.status + ")"
        );
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Errore durante l'elaborazione del file");
      }

      setOriginalHtml(data.text || "");
      setWorkedHtml("");
      setManuscriptEvaluation("");
      setRecommendationSummary("");
      setStatus(
        `File caricato e testo importato correttamente (${file.name}). Ora puoi fare valutazione, correzione o editing.`
      );
    } catch (err) {
      console.error(err);
      setStatus("Errore durante il caricamento del file: " + err.message);
      alert("Errore upload: " + err.message);
    } finally {
      setIsUploading(false);
      event.target.value = "";
    }
  };

  // Carica valutazione salvata per Titolo + Autore
  const loadEvaluationFor = async (title, author) => {
    const trimmedTitle = (title || "").trim();
    const trimmedAuthor = (author || "").trim();

    if (!trimmedTitle && !trimmedAuthor) {
      alert(
        "Per caricare una valutazione salvata indica almeno il titolo progetto (meglio titolo + autore)."
      );
      return;
    }

    try {
      setStatus("Ricerca valutazione salvata per questo progetto...");
      const response = await fetch(
        "http://localhost:3001/api/load-evaluation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectTitle: trimmedTitle,
            projectAuthor: trimmedAuthor,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        const msg =
          data && data.error
            ? data.error
            : "Nessuna valutazione trovata per questo progetto.";
        setStatus(msg);
        alert(msg);
        return;
      }

      const evalHtml = data.evaluationHtml || "";
      setManuscriptEvaluation(evalHtml);
      setWorkedHtml(evalHtml);
      setRecommendationSummary(extractRecommendation(evalHtml));
      setStatus(
        "Valutazione manoscritto caricata dal salvataggio per questo progetto."
      );
    } catch (err) {
      console.error(err);
      setStatus("Errore nel caricamento della valutazione: " + err.message);
      alert("Errore nel caricamento della valutazione: " + err.message);
    }
  };

  // Pulsante "Carica valutazione salvata"
  const handleLoadEvaluation = async () => {
    await loadEvaluationFor(projectTitle, projectAuthor);
  };

  // Elenco progetti salvati
  const handleToggleProjects = async () => {
    if (showProjects) {
      setShowProjects(false);
      return;
    }

    try {
      setStatus("Caricamento elenco progetti salvati...");
      const response = await fetch("http://localhost:3001/api/projects");
      const data = await response.json();

      if (!response.ok || !data.success) {
        const msg =
          data && data.error
            ? data.error
            : "Errore nel caricamento dell'elenco progetti.";
        setStatus(msg);
        alert(msg);
        return;
      }

      setSavedProjects(data.projects || []);
      setShowProjects(true);
      setStatus("Progetti salvati caricati.");
    } catch (err) {
      console.error(err);
      setStatus("Errore nel caricamento dei progetti: " + err.message);
      alert("Errore nel caricamento dei progetti: " + err.message);
    }
  };

  // Chiamata AI (correzione / editing / traduzioni / valutazione)
  const callAi = async (mode) => {
    if (!originalHtml.trim()) {
      setStatus(
        "Devi prima importare un DOCX o un PDF per avere del testo di partenza."
      );
      alert("Importa un DOCX o un PDF prima di usare l'AI.");
      return;
    }

    if (!mode || mode === "none") {
      alert(
        "Seleziona prima una modalità valida (valutazione, correzione, editing o traduzione)."
      );
      return;
    }

    // Avviso se provi a fare EDITING su un libro intero in un colpo solo
    if (mode === "editing-profondo" && originalHtml.length > 120000) {
      const proceed = window.confirm(
        "Il testo è molto lungo (sembra un libro intero).\n" +
          "Per evitare che il modello tagli o riassuma, è consigliato usare il pulsante «Editing libro intero», che lavora a blocchi.\n\n" +
          "Vuoi comunque procedere con l'editing in un'unica chiamata?"
      );
      if (!proceed) {
        setStatus(
          "Operazione annullata: usa «Editing libro intero» per testi così lunghi."
        );
        return;
      }
    }

    try {
      setIsAiLoading(true);
      setLastAiMode(mode);
      setStatus(`Invio richiesta AI in modalità: ${mode}...`);

      const body = {
        text: originalHtml,
        mode,
        projectTitle: projectTitle.trim(),
        projectAuthor: projectAuthor.trim(),
      };

      // Se siamo in editing e c'è una valutazione salvata, la passiamo come contesto
      if (
        (mode === "editing-profondo" || mode === "editing") &&
        manuscriptEvaluation.trim()
      ) {
        body.editorialContext = manuscriptEvaluation;
      }

      const response = await fetch("http://localhost:3001/api/ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error("Errore dal server AI (status " + response.status + ")");
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Errore generico AI");
      }

      const result = data.result || "";

      // Se è una valutazione manoscritto, salviamo anche nello stato dedicato
      if (mode === "valutazione-manoscritto") {
        setManuscriptEvaluation(result);
        setRecommendationSummary(extractRecommendation(result));
        setStatus(
          "Valutazione manoscritto completata e salvata per questo progetto. Verrà usata come contesto per l'editing libro intero."
        );
      } else {
        setStatus("Testo aggiornato con la risposta AI.");
      }

      // Mostriamo comunque il risultato nella colonna destra
      setWorkedHtml(result);
    } catch (err) {
      console.error(err);
      setStatus(
        "Errore nella chiamata AI: " +
          err.message +
          " (controlla anche la finestra del server AI)."
      );
      alert("Errore AI: " + err.message);
    } finally {
      setIsAiLoading(false);
      setLastAiMode(null);
    }
  };

  // Correzione libro intero (a blocchi) – CORREZIONE TESTO
  const handleBookCorrection = async () => {
    if (!originalHtml.trim()) {
      alert(
        "Inserisci prima il libro (o un testo lungo) nella colonna di sinistra (importando il DOCX o il PDF)."
      );
      return;
    }

    const chunks = splitHtmlIntoChunks(originalHtml, 40000);

    if (chunks.length === 1) {
      const conferma = window.confirm(
        "Il testo risulta in un solo blocco. Vuoi comunque usare la correzione normale AI (Correzione testo) su tutto?"
      );
      if (conferma) {
        await callAi("correzione-soft");
      }
      return;
    }

    const conferma = window.confirm(
      `Il libro sarà diviso in ${chunks.length} blocchi più grandi (circa 40.000 caratteri ciascuno) per la CORREZIONE TESTO.\n` +
        "Questo userà diverse chiamate alle API (e quindi credito). Vuoi procedere?"
    );
    if (!conferma) return;

    setIsBookProcessing(true);
    setIsAiLoading(true);
    setLastAiMode("correzione-libro");
    setStatus(`Correzione libro avviata: ${chunks.length} blocchi da elaborare...`);
    setBookProgress(`Blocco 1 di ${chunks.length}`);
    setWorkedHtml("");

    const results = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const blocco = chunks[i];
        setBookProgress(`Blocco ${i + 1} di ${chunks.length}`);

        const response = await fetch("http://localhost:3001/api/ai", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: blocco,
            mode: "correzione-soft",
          }),
        });

        if (!response.ok) {
          throw new Error(
            "Errore dal server AI (status " +
              response.status +
              ") nel blocco " +
              (i + 1)
          );
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(
            (data.error || "Errore generico AI") + " nel blocco " + (i + 1)
          );
        }

        results.push(data.result || "");
      }

      const finalHtml = results.join("");
      setWorkedHtml(finalHtml);
      setStatus("Libro corretto completamente. Testo completo nella colonna destra.");
      setBookProgress("");
    } catch (err) {
      console.error(err);
      setStatus("Errore nella correzione del libro: " + err.message);
      alert("Errore nella correzione del libro:\n" + err.message);
    } finally {
      setIsBookProcessing(false);
      setIsAiLoading(false);
      setLastAiMode(null);
    }
  };

  // Editing libro intero (a blocchi) – EDITING, con raccomandazione editoriale se presente
  const handleBookEditing = async () => {
    if (!originalHtml.trim()) {
      alert(
        "Inserisci prima il libro (o un testo lungo) nella colonna di sinistra (importando il DOCX o il PDF)."
      );
      return;
    }

    const chunks = splitHtmlIntoChunks(originalHtml, 40000);

    if (chunks.length === 1) {
      const conferma = window.confirm(
        "Il testo risulta in un solo blocco. Vuoi comunque usare l'Editing normale AI su tutto?"
      );
      if (conferma) {
        await callAi("editing-profondo");
      }
      return;
    }

    const conferma = window.confirm(
      `Il libro sarà diviso in ${chunks.length} blocchi più grandi (circa 40.000 caratteri ciascuno) per l'EDITING.\n` +
        "Questo userà diverse chiamate alle API (e quindi credito).\n\n" +
        (manuscriptEvaluation.trim()
          ? "È presente una VALUTAZIONE MANOSCRITTO salvata: verrà usata come contesto per rendere l'editing coerente con la raccomandazione editoriale.\n\n"
          : "Non è presente una valutazione manoscritto salvata: l'editing sarà neutro, senza contesto editoriale aggiuntivo.\n\n") +
        "Vuoi procedere?"
    );
    if (!conferma) return;

    setIsBookProcessing(true);
    setIsAiLoading(true);
    setLastAiMode("editing-libro");
    setStatus(`Editing libro avviato: ${chunks.length} blocchi da elaborare...`);
    setBookProgress(`Blocco 1 di ${chunks.length}`);
    setWorkedHtml("");

    const results = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const blocco = chunks[i];
        setBookProgress(`Blocco ${i + 1} di ${chunks.length}`);

        const body = {
          text: blocco,
          mode: "editing-profondo",
          projectTitle: projectTitle.trim(),
          projectAuthor: projectAuthor.trim(),
        };

        if (manuscriptEvaluation.trim()) {
          body.editorialContext = manuscriptEvaluation;
        }

        const response = await fetch("http://localhost:3001/api/ai", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(
            "Errore dal server AI (status " +
              response.status +
              ") nel blocco " +
              (i + 1)
          );
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(
            (data.error || "Errore generico AI") + " nel blocco " + (i + 1)
          );
        }

        results.push(data.result || "");
      }

      const finalHtml = results.join("");
      setWorkedHtml(finalHtml);
      setStatus(
        "Libro editato completamente. Testo completo nella colonna destra."
      );
      setBookProgress("");
    } catch (err) {
      console.error(err);
      setStatus("Errore nell'editing del libro: " + err.message);
      alert("Errore nell'editing del libro:\n" + err.message);
    } finally {
      setIsBookProcessing(false);
      setIsAiLoading(false);
      setLastAiMode(null);
    }
  };

  // Download versione lavorata in .docx (qualsiasi contenuto nella colonna destra)
  const handleDownloadWorkedDocx = async () => {
    if (!workedHtml || workedHtml.trim() === "") {
      alert("Non c'è ancora nessun testo lavorato da scaricare.");
      return;
    }

    try {
      setStatus("Generazione file Word (.docx) in corso...");

      let baseName = "testo-lavorato-fermento";
      const cleanTitle = projectTitle
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");
      const cleanAuthor = projectAuthor
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");

      if (cleanTitle || cleanAuthor) {
        baseName = `${cleanTitle || "Progetto"}-${cleanAuthor || "Autore"}`;
      }

      const filename = `${baseName}.docx`;

      const response = await fetch("http://localhost:3001/api/download-docx", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          correctedHtml: workedHtml,
          filename,
        }),
      });

      if (!response.ok) {
        throw new Error("Errore nella risposta del server (DOCX).");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setStatus("File Word (.docx) scaricato correttamente.");
    } catch (err) {
      console.error("Errore download DOCX:", err);
      setStatus("Errore durante il download del DOCX: " + err.message);
      alert("Si è verificato un errore durante il download del DOCX.");
    }
  };

  // Download della sola valutazione in DOCX
  const handleDownloadEvaluationDocx = async () => {
    if (!manuscriptEvaluation.trim()) {
      alert(
        "Non è presente alcuna valutazione manoscritto da scaricare. Esegui prima una valutazione o caricane una salvata."
      );
      return;
    }

    try {
      setStatus("Generazione DOCX della valutazione in corso...");

      let baseName = "valutazione-manoscritto";
      const cleanTitle = projectTitle
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");
      const cleanAuthor = projectAuthor
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");

      if (cleanTitle || cleanAuthor) {
        baseName = `${cleanTitle || "Progetto"}-${cleanAuthor || "Autore"}-valutazione`;
      }

      const filename = `${baseName}.docx`;

      const response = await fetch("http://localhost:3001/api/download-docx", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          correctedHtml: manuscriptEvaluation,
          filename,
        }),
      });

      if (!response.ok) {
        throw new Error("Errore nella risposta del server (DOCX valutazione).");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setStatus("DOCX della valutazione scaricato correttamente.");
    } catch (err) {
      console.error("Errore download DOCX valutazione:", err);
      setStatus("Errore durante il download del DOCX valutazione: " + err.message);
      alert(
        "Si è verificato un errore durante il download del DOCX della valutazione."
      );
    }
  };

  // Download della sola valutazione in PDF (testo semplice)
  const handleDownloadEvaluationPdf = async () => {
    if (!manuscriptEvaluation.trim()) {
      alert(
        "Non è presente alcuna valutazione manoscritto da scaricare. Esegui prima una valutazione o caricane una salvata."
      );
      return;
    }

    try {
      setStatus("Generazione PDF della valutazione in corso...");

      let baseName = "valutazione-manoscritto";
      const cleanTitle = projectTitle
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");
      const cleanAuthor = projectAuthor
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_");

      if (cleanTitle || cleanAuthor) {
        baseName = `${cleanTitle || "Progetto"}-${cleanAuthor || "Autore"}-valutazione`;
      }

      const filename = `${baseName}.pdf`;

      const response = await fetch(
        "http://localhost:3001/api/download-eval-pdf",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            evaluationHtml: manuscriptEvaluation,
            filename,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Errore nella risposta del server (PDF valutazione).");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setStatus("PDF della valutazione scaricato correttamente.");
    } catch (err) {
      console.error("Errore download PDF valutazione:", err);
      setStatus("Errore durante il download del PDF valutazione: " + err.message);
      alert(
        "Si è verificato un errore durante il download del PDF della valutazione."
      );
    }
  };

  const originalStats = getStats(originalHtml);
  const workedStats = getStats(workedHtml);

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#fdf7f2",
        color: "#333",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* HEADER */}
      <header
        style={{
          width: "100%",
          borderBottom: "1px solid #e0d5c5",
          backgroundColor: "rgba(255,255,255,0.9)",
          padding: "8px 0",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                backgroundColor: "#c0392b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontWeight: "bold",
                fontSize: "14px",
              }}
            >
              F
            </div>
            <div>
              <div style={{ fontWeight: "600", letterSpacing: "0.04em" }}>
                Fermento Editor
              </div>
              <div style={{ fontSize: "11px", color: "#777" }}>
                Studio testi per la casa editrice Fermento
              </div>
            </div>
          </div>

          <div
            style={{
              fontSize: "11px",
              color: "#666",
              textAlign: "right",
              position: "relative",
              flexShrink: 0,
            }}
          >
            <div style={{ marginBottom: "4px" }}>
              Progetto:{" "}
              <input
                type="text"
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                placeholder="Titolo progetto"
                style={{
                  fontSize: "11px",
                  padding: "2px 4px",
                  borderRadius: "4px",
                  border: "1px solid #e0d5c5",
                  width: "200px",
                  marginBottom: "2px",
                }}
              />
            </div>
            <div style={{ marginBottom: "4px" }}>
              Autore:{" "}
              <input
                type="text"
                value={projectAuthor}
                onChange={(e) => setProjectAuthor(e.target.value)}
                placeholder="Autore"
                style={{
                  fontSize: "11px",
                  padding: "2px 4px",
                  borderRadius: "4px",
                  border: "1px solid #e0d5c5",
                  width: "200px",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: "4px",
                justifyContent: "flex-end",
                marginTop: "4px",
              }}
            >
              <button
                onClick={handleLoadEvaluation}
                style={{
                  padding: "3px 6px",
                  borderRadius: "4px",
                  border: "1px solid #2980b9",
                  backgroundColor: manuscriptEvaluation.trim()
                    ? "#2980b9"
                    : "#ffffff",
                  color: manuscriptEvaluation.trim() ? "#ffffff" : "#2980b9",
                  fontSize: "10px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                {manuscriptEvaluation.trim()
                  ? "Ricarica valutazione salvata"
                  : "Carica valutazione salvata"}
              </button>

              <button
                onClick={handleToggleProjects}
                style={{
                  padding: "3px 6px",
                  borderRadius: "4px",
                  border: "1px solid #7f8c8d",
                  backgroundColor: showProjects ? "#7f8c8d" : "#ffffff",
                  color: showProjects ? "#ffffff" : "#7f8c8d",
                  fontSize: "10px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Progetti salvati
              </button>
            </div>

            {/* PANNELLO ELENCO PROGETTI */}
            {showProjects && (
              <div
                style={{
                  position: "absolute",
                  top: "70px",
                  right: 0,
                  width: "260px",
                  maxHeight: "260px",
                  overflowY: "auto",
                  backgroundColor: "#ffffff",
                  border: "1px solid #e0d5c5",
                  borderRadius: "8px",
                  boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
                  padding: "8px",
                  zIndex: 10,
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "600",
                    marginBottom: "4px",
                    color: "#2c3e50",
                  }}
                >
                  Progetti con valutazione salvata
                </div>
                {savedProjects.length === 0 ? (
                  <div style={{ fontSize: "10px", color: "#999" }}>
                    Nessun progetto salvato al momento.
                  </div>
                ) : (
                  savedProjects.map((p, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "4px 6px",
                        borderRadius: "4px",
                        borderBottom:
                          idx === savedProjects.length - 1
                            ? "none"
                            : "1px solid #f0e6d8",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                      onClick={() => {
                        setProjectTitle(p.title || "");
                        setProjectAuthor(p.author || "");
                        setShowProjects(false);
                        loadEvaluationFor(p.title, p.author);
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: "600",
                          color: "#2c3e50",
                        }}
                      >
                        {p.title || "(senza titolo)"}
                      </div>
                      <div
                        style={{
                          fontSize: "10px",
                          color: "#7f8c8d",
                        }}
                      >
                        {p.author || "Autore sconosciuto"}
                      </div>
                      {p.updatedAt && (
                        <div
                          style={{
                            fontSize: "10px",
                            color: "#b0a79b",
                          }}
                        >
                          Ultimo aggiornamento:{" "}
                          {new Date(p.updatedAt).toLocaleString("it-IT")}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* BARRA PULSANTI */}
      <div
        style={{
          borderBottom: "1px solid #e0d5c5",
          backgroundColor: "#fcf4eb",
        }}
      >
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 0",
            fontSize: "13px",
            flexWrap: "wrap",
          }}
        >
          {/* input file nascosto */}
          <input
            id="docx-input"
            type="file"
            accept=".docx,.pdf"
            style={{ display: "none" }}
            onChange={handleDocxUpload}
          />

          <button
            onClick={() => {
              const el = document.getElementById("docx-input");
              if (el && !isUploading && !isBookProcessing && !isAiLoading)
                el.click();
            }}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#34495e",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isUploading || isBookProcessing || isAiLoading
                  ? "default"
                  : "pointer",
              opacity: isUploading ? 0.7 : 1,
            }}
            disabled={isUploading || isBookProcessing || isAiLoading}
          >
            {isUploading
              ? "Caricamento file..."
              : "Carica file (.docx / .pdf)"}
          </button>

          <span style={{ fontWeight: "600", marginLeft: "8px" }}>
            Tipo intervento:
          </span>

          {/* VALUTAZIONE MANOSCRITTO */}
          <button
            onClick={() => callAi("valutazione-manoscritto")}
            disabled={isAiLoading || isBookProcessing}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#2980b9",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading || isBookProcessing ? "default" : "pointer",
              opacity:
                isAiLoading && lastAiMode === "valutazione-manoscritto"
                  ? 0.7
                  : 1,
            }}
          >
            {isAiLoading && lastAiMode === "valutazione-manoscritto"
              ? "AI: valutazione..."
              : "Valutazione manoscritto"}
          </button>

          {/* CORREZIONE TESTO */}
          <button
            onClick={() => callAi("correzione-soft")}
            disabled={isAiLoading || isBookProcessing}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#2c3e50",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading || isBookProcessing ? "default" : "pointer",
              opacity:
                isAiLoading && lastAiMode === "correzione-soft" ? 0.7 : 1,
            }}
          >
            {isAiLoading && lastAiMode === "correzione-soft"
              ? "AI: correzione..."
              : "Correzione testo"}
          </button>

          {/* EDITING */}
          <button
            onClick={() => callAi("editing-profondo")}
            disabled={isAiLoading || isBookProcessing}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#8e44ad",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading || isBookProcessing ? "default" : "pointer",
              opacity:
                isAiLoading && lastAiMode === "editing-profondo" ? 0.7 : 1,
            }}
          >
            {isAiLoading && lastAiMode === "editing-profondo"
              ? "AI: editing..."
              : "Editing"}
          </button>

          {/* CORREZIONE LIBRO INTERO */}
          <button
            onClick={handleBookCorrection}
            disabled={isAiLoading || isBookProcessing}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#d35400",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading || isBookProcessing ? "default" : "pointer",
              opacity:
                isBookProcessing && lastAiMode === "correzione-libro"
                  ? 0.8
                  : 1,
            }}
          >
            {isBookProcessing && lastAiMode === "correzione-libro"
              ? "AI: correzione libro..."
              : "Correzione libro intero"}
          </button>

          {/* EDITING LIBRO INTERO */}
          <button
            onClick={handleBookEditing}
            disabled={isAiLoading || isBookProcessing}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#e67e22",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading || isBookProcessing ? "default" : "pointer",
              opacity:
                isBookProcessing && lastAiMode === "editing-libro"
                  ? 0.8
                  : 1,
            }}
          >
            {isBookProcessing && lastAiMode === "editing-libro"
              ? "AI: editing libro..."
              : "Editing libro intero"}
          </button>

          <div style={{ flex: 1, minWidth: "8px" }} />

          {/* Traduzioni */}
          <select
            value={translationMode}
            onChange={(e) => setTranslationMode(e.target.value)}
            style={{
              fontSize: "11px",
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #e0d5c5",
              marginRight: "6px",
            }}
          >
            <option value="none">– Traduzione –</option>
            <option value="traduzione-it-en">IT → EN</option>
            <option value="traduzione-en-it">EN → IT</option>
            <option value="traduzione-fr-it">FR → IT</option>
            <option value="traduzione-es-it">ES → IT</option>
            <option value="traduzione-de-it">DE → IT</option>
            <option value="traduzione-it-es">IT → ES</option>
            <option value="traduzione-it-fr">IT → FR</option>
            <option value="traduzione-it-de">IT → DE</option>
          </select>

          <button
            onClick={() => callAi(translationMode)}
            disabled={
              isAiLoading || isBookProcessing || translationMode === "none"
            }
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#16a085",
              color: "white",
              border: "none",
              fontSize: "11px",
              fontWeight: "600",
              cursor:
                isAiLoading ||
                isBookProcessing ||
                translationMode === "none"
                  ? "default"
                  : "pointer",
            }}
          >
            {isAiLoading &&
            lastAiMode &&
            lastAiMode.startsWith("traduzione")
              ? "AI: traducendo..."
              : "Traduzione"}
          </button>

          {/* DOWNLOAD DOCX (testo lavorato) */}
          <button
            onClick={handleDownloadWorkedDocx}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#ffffff",
              color: "#2c3e50",
              border: "1px solid #2c3e50",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Scarica versione lavorata (.docx)
          </button>

          {/* DOWNLOAD valutazione DOCX/PDF */}
          <button
            onClick={handleDownloadEvaluationDocx}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: manuscriptEvaluation.trim()
                ? "#ffffff"
                : "#f8f1ea",
              color: "#8e44ad",
              border: "1px solid #8e44ad",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Valutazione (.docx)
          </button>

          <button
            onClick={handleDownloadEvaluationPdf}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: manuscriptEvaluation.trim()
                ? "#ffffff"
                : "#f8f1ea",
              color: "#c0392b",
              border: "1px solid #c0392b",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Valutazione (.pdf)
          </button>
        </div>
      </div>

      {/* DUE COLONNE: VISTA FORMATTATA */}
      <main style={{ flex: 1 }}>
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            height: "100%",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            padding: "16px 0",
          }}
        >
          {/* ORIGINALE FORMATTATO */}
          <section
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "4px",
              }}
            >
              <h2
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                Testo originale
              </h2>
              <span style={{ fontSize: "10px", color: "#777" }}>
                Vista formattata (da DOCX/PDF)
              </span>
            </div>

            <div
              style={{
                fontSize: "10px",
                color: "#777",
                marginBottom: "4px",
              }}
            >
              Parole:{" "}
              <span style={{ fontWeight: "600" }}>{originalStats.words}</span>{" "}
              · Caratteri:{" "}
              <span style={{ fontWeight: "600" }}>{originalStats.chars}</span>
            </div>

            <div
              style={{
                flex: 1,
                minHeight: "400px",
                border: "1px solid #e0d5c5",
                borderRadius: "8px",
                padding: "12px",
                fontSize: "13px",
                fontFamily: "serif",
                backgroundColor: "#ffffff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                overflowY: "auto",
              }}
              dangerouslySetInnerHTML={{
                __html: originalHtml
                  ? originalHtml
                  : "<p style='color:#aaa'>Importa un DOCX o un PDF con il pulsante in alto.</p>",
              }}
            />
          </section>

          {/* LAVORATO / VALUTAZIONE */}
          <section
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
            }}
          >
            {/* Riquadro Raccomandazione editoriale */}
            {recommendationSummary && (
              <div
                style={{
                  border: "1px solid #e0d5c5",
                  borderRadius: "8px",
                  padding: "8px",
                  marginBottom: "8px",
                  backgroundColor: "#fffaf3",
                  fontSize: "11px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: "600",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#8e44ad",
                    marginBottom: "4px",
                  }}
                >
                  Raccomandazione editoriale (estratto)
                </div>
                <div
                  style={{ fontSize: "11px", color: "#444", lineHeight: 1.4 }}
                  dangerouslySetInnerHTML={{
                    __html: recommendationSummary,
                  }}
                />
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "4px",
              }}
            >
              <h2
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                Versione lavorata / valutazione
              </h2>
              <span style={{ fontSize: "10px", color: "#777" }}>
                Risultato AI (vista formattata)
              </span>
            </div>

            <div
              style={{
                fontSize: "10px",
                color: "#777",
                marginBottom: "4px",
              }}
            >
              Parole:{" "}
              <span style={{ fontWeight: "600" }}>{workedStats.words}</span>{" "}
              · Caratteri:{" "}
              <span style={{ fontWeight: "600" }}>{workedStats.chars}</span>
              {manuscriptEvaluation.trim() && (
                <span style={{ marginLeft: "8px", color: "#2c3e50" }}>
                  • Valutazione manoscritto salvata
                </span>
              )}
            </div>

            <div
              style={{
                flex: 1,
                minHeight: "400px",
                border: "1px solid #e0d5c5",
                borderRadius: "8px",
                padding: "12px",
                fontSize: "13px",
                fontFamily: "serif",
                backgroundColor: "#ffffff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                overflowY: "auto",
              }}
              dangerouslySetInnerHTML={{
                __html: workedHtml
                  ? workedHtml
                  : "<p style='color:#aaa'>Qui comparirà il testo dopo correzione / editing / traduzione o la valutazione del manoscritto.</p>",
              }}
            />
          </section>
        </div>
      </main>

      {/* BARRA DI STATO */}
      <footer
        style={{
          borderTop: "1px solid #e0d5c5",
          backgroundColor: "#fcf4eb",
          padding: "6px 0",
        }}
      >
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            fontSize: "11px",
            color: "#666",
          }}
        >
          <strong>Stato:</strong> {status}
          {bookProgress && (
            <span style={{ marginLeft: "8px" }}>
              · <strong>Avanzamento libro:</strong> {bookProgress}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
