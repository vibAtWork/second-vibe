// Keeps the parameter field in sync with the chosen treatment (placeholder + enabled state).
(function () {
  const hints = {
    KEEP: "", DROP: "", MASK: "[REDACTED]", HASH: "16", PSEUDONYM: "ID-", SUPPRESS_RARE: "k = 5",
    ROUND: "decimals, e.g. 0 or -1",
  };
  function generalizeHint(type) {
    if (type === "DATE" || type === "DATETIME") return "year | month | decade";
    if (type === "INTEGER" || type === "DECIMAL") return "bin width, e.g. 10";
    return "chars to keep, e.g. 2";
  }
  document.addEventListener("change", function (e) {
    const sel = e.target;
    if (!sel.matches || !sel.matches("select.action")) return;
    const input = sel.closest("tr").querySelector("input.param");
    if (!input) return;
    const a = sel.value;
    input.placeholder = a === "GENERALIZE" ? generalizeHint(sel.dataset.type) : (hints[a] || "");
    input.disabled = a === "KEEP" || a === "DROP";
    if (input.disabled) input.value = "";
  }, true);
})();
