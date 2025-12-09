import React from "react";

const ActionButtons = ({ callAi, isAiLoading, lastAiMode }) => {
  return (
    <div className="buttons-row">
      <button
        onClick={() => callAi("correzione-soft")}
        disabled={isAiLoading}
      >
        {isAiLoading && lastAiMode === "correzione-soft"
          ? "AI: correzione..."
          : "Correzione testo"}
      </button>

      <button onClick={() => callAi("editing-leggero")} disabled={isAiLoading}>
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

      <button onClick={() => callAi("traduzione-it-en")} disabled={isAiLoading}>
        Traduzione IT → EN
      </button>
    </div>
  );
};

export default React.memo(ActionButtons);
