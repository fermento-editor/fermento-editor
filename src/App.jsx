import { useState, useEffect } from "react";
import "./App.css";

// Base URL API: locale vs online
const API_BASE =
  window.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://fermento-editor.onrender.com";

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

function App() {
  const [originalHtml, setOriginalHtml] = useState(""); // HTML importato
  const [workedHtml, setWorkedHtml] = useState(""); // HTML lavorato
  const [status, setStatus] = useState("Pronto.");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [lastAiMode, setLastAiMode] = useState(null);
  const [isBookProcessing, setIsBookProcessing] = useState(false);
  const [bookProgress, setBookProgress] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const [projectTitle, setProjectTitle] = useState("");
  const [projectAuthor, setProjectAuthor] = useState("");
  const [translationMode, setTranslationMode] = useState("none");

  // Stato per valutazioni salvate
  const [evaluations, setEvaluations] = useState([]);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState("");
  const [loadingEvaluationId, setLoadingEvaluationId] = useState(null);

  // Carica valutazioni manoscritti salvate da backend
  useEffect(() => {
    const fetchEvaluations = async () => {
      try {
        setEvalLoading(true);
        setEvalError("");

        const response = await fetch(`${API_BASE}/api/evaluations`);
        if (!response.ok) {
          throw new Error("Risposta non valida dal server valutazioni");
        }
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Errore nel caricamento valutazioni");
        }
        setEvaluations(data.evaluations || []);
      } catch (err) {
        console.error("Errore nel recupero delle valutazioni:", err);
        setEvalError(
          "Impossibile recuperare le valutazioni salvate. Controlla la configurazione del server."
        );
      } finally {
        setEvalLoading(false);
      }
    };

    fetchEvaluations();
  }, []);

  // Upload DOCX/PDF → backend → HTML (con formattazione base)
  const handleDocxUpload = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const name = file.name.toLowerCase();
    if (!name.endsWith(".docx") && !name.endsWith(".pdf")) {
      alert("Puoi caricare solo file .docx (Word) o .pdf.");
      event.target.value = "";
      return;
    }

    try {
      setIsUploading(true);
      setStatus(`Caricamento file "${file.name}" in corso...`);

      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/api/upload-docx`, {
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
      setStatus(
        `File caricato e testo importato correttamente (${file.name}).`
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

  // Chiamata AI (correzione testo / editing / traduzioni / valutazione)
  const callAi = async (mode) => {
    if (!originalHtml.trim()) {
      setStatus(
        "Devi prima importare un DOCX/PDF o avere del testo di partenza (HTML)."
      );
      alert("Importa un DOCX o PDF prima di usare l'AI.");
      return;
    }

    if (!mode || mode === "none") {
      alert(
        "Seleziona prima una modalità valida (correzione testo, editing, traduzione o valutazione manoscritto)."
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

      const response = await fetch(`${API_BASE}/api/ai`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: originalHtml, // HTML
          mode,
          projectTitle,
          projectAuthor,
        }),
      });

      if (!response.ok) {
        throw new Error("Errore dal server AI (status " + response.status + ")");
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Errore generico AI");
      }

      setWorkedHtml(data.result || "");
      setStatus("Testo aggiornato con la risposta AI.");

      // Se abbiamo appena fatto una valutazione manoscritto, ricarichiamo l'elenco
      if (mode === "valutazione-manoscritto") {
        try {
          setEvalLoading(true);
          const resEval = await fetch(`${API_BASE}/api/evaluations`);
          if (resEval.ok) {
            const evalData = await resEval.json();
            if (evalData.success) {
              setEvaluations(evalData.evaluations || []);
            }
          }
        } catch (err) {
          console.error(
            "Errore aggiornamento elenco valutazioni dopo valutazione:",
            err
          );
        } finally {
          setEvalLoading(false);
        }
      }
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
        "Inserisci prima il libro (o un testo lungo) nella colonna di sinistra (importando il DOCX/PDF)."
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

        const response = await fetch(`${API_BASE}/api/ai`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: blocco,
            mode: "correzione-soft",
            projectTitle,
            projectAuthor,
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

  // Editing libro intero (a blocchi) – EDITING
  const handleBookEditing = async () => {
    if (!originalHtml.trim()) {
      alert(
        "Inserisci prima il libro (o un testo lungo) nella colonna di sinistra (importando il DOCX/PDF)."
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
        "Questo userà diverse chiamate alle API (e quindi credito). Vuoi procedere?"
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

        const response = await fetch(`${API_BASE}/api/ai`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: blocco,
            mode: "editing-profondo",
            projectTitle,
            projectAuthor,
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
      setStatus("Libro editato completamente. Testo completo nella colonna destra.");
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

  // Download versione lavorata in .docx
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

      const response = await fetch(`${API_BASE}/api/download-docx`, {
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

  // Carica una valutazione salvata nella colonna destra
  const handleOpenEvaluation = async (id) => {
    try {
      setLoadingEvaluationId(id);
      setStatus("Caricamento valutazione in corso...");

      const response = await fetch(`${API_BASE}/api/evaluations/${id}`);
      if (!response.ok) {
        throw new Error("Errore nel recupero della valutazione salvata");
      }
      const data = await response.json();
      if (!data.success || !data.evaluation) {
        throw new Error("Valutazione non trovata nel server");
      }

      const ev = data.evaluation;
      setWorkedHtml(ev.evaluationHtml || "");
      setStatus(
        `Valutazione caricata: ${ev.title || "Senza titolo"}${
          ev.author ? " – " + ev.author : ""
        }.`
      );
    } catch (err) {
      console.error("Errore apertura valutazione:", err);
      setStatus("Errore nel caricamento della valutazione: " + err.message);
      alert("Errore nel caricamento della valutazione: " + err.message);
    } finally {
      setLoadingEvaluationId(null);
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
        }}
      >
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
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

          <div style={{ fontSize: "11px", color: "#666", textAlign: "right" }}>
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
                  width: "160px",
                }}
              />
            </div>
            <div>
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
                  width: "160px",
                }}
              />
            </div>
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

          {/* VALUTAZIONE MANOSCRITTO (PRIMA) */}
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
              ? "AI: correzione testo..."
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
                isBookProcessing && lastAiMode === "editing-libro" ? 0.8 : 1,
            }}
          >
            {isBookProcessing && lastAiMode === "editing-libro"
              ? "AI: editing libro..."
              : "Editing libro intero"}
          </button>

          <div style={{ flex: 1 }} />

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

          {/* DOWNLOAD DOCX */}
          <button
            onClick={handleDownloadWorkedDocx}
            style={{
              padding: "6px 14px",
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
                Vista formattata (dal file importato)
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
                  : "<p style='color:#aaa'>Importa un DOCX o PDF con il pulsante in alto.</p>",
              }}
            />
          </section>

          {/* LAVORATO FORMATTATO */}
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
                Versione lavorata
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
                  : "<p style='color:#aaa'>Qui comparirà il testo dopo correzione / editing / traduzione / valutazione.</p>",
              }}
            />
          </section>
        </div>

        {/* SEZIONE VALUTAZIONI SALVATE */}
        <div
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
            padding: "8px 0 16px 0",
            borderTop: "1px solid #e0d5c5",
          }}
        >
          <h3
            style={{
              fontSize: "12px",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "8px",
            }}
          >
            Valutazioni manoscritti salvate
          </h3>

          {evalLoading ? (
            <p style={{ fontSize: "11px", color: "#777" }}>
              Caricamento valutazioni in corso...
            </p>
          ) : evalError ? (
            <p style={{ fontSize: "11px", color: "#b71c1c" }}>{evalError}</p>
          ) : evaluations.length === 0 ? (
            <p style={{ fontSize: "11px", color: "#777" }}>
              Nessuna valutazione salvata o server non configurato per
              restituirle.
            </p>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              {evaluations.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    border: "1px solid #e0d5c5",
                    borderRadius: "6px",
                    padding: "8px",
                    backgroundColor: "#fff",
                    fontSize: "11px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: "4px",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <strong>{ev.title || "Senza titolo"}</strong>
                      {ev.author ? (
                        <span style={{ marginLeft: "4px", color: "#555" }}>
                          – {ev.author}
                        </span>
                      ) : null}
                      <div
                        style={{
                          color: "#999",
                          fontSize: "10px",
                          marginTop: "2px",
                        }}
                      >
                        {ev.createdAt
                          ? new Date(ev.createdAt).toLocaleString()
                          : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => handleOpenEvaluation(ev.id)}
                      disabled={loadingEvaluationId === ev.id}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "4px",
                        border: "1px solid #2980b9",
                        backgroundColor:
                          loadingEvaluationId === ev.id ? "#ecf6fc" : "#ffffff",
                        color: "#2980b9",
                        fontSize: "10px",
                        fontWeight: "600",
                        cursor:
                          loadingEvaluationId === ev.id ? "default" : "pointer",
                      }}
                    >
                      {loadingEvaluationId === ev.id
                        ? "Apro..."
                        : "Apri valutazione"}
                    </button>
                  </div>
                  {ev.recommendationSummary && (
                    <div style={{ color: "#555", marginTop: "4px" }}>
                      <span style={{ fontWeight: "600" }}>
                        Raccomandazione:
                      </span>{" "}
                      {ev.recommendationSummary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
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
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <div>
            <strong>Stato:</strong> {status}
            {bookProgress && (
              <span style={{ marginLeft: "8px" }}>
                · <strong>Avanzamento libro:</strong> {bookProgress}
              </span>
            )}
          </div>
          <div>
            <strong>API:</strong> {API_BASE}
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
