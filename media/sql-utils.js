(function () {
  function escapeHtmlChars(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function syntaxHighlightJson(json) {
    const parts = [];
    let lastIndex = 0;
    const regex =
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"\s*:?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
    let match;

    while ((match = regex.exec(json)) !== null) {
      if (match.index > lastIndex) {
        parts.push(escapeHtmlChars(json.slice(lastIndex, match.index)));
      }

      const token = match[0];
      let className;
      if (token[0] === '"') {
        className = /:\s*$/.test(token) ? "json-key" : "json-string";
      } else if (token === "true" || token === "false") {
        className = "json-boolean";
      } else if (token === "null") {
        className = "json-null";
      } else {
        className = "json-number";
      }

      parts.push(`<span class="${className}">${escapeHtmlChars(token)}</span>`);
      lastIndex = match.index + token.length;
    }

    if (lastIndex < json.length) {
      parts.push(escapeHtmlChars(json.slice(lastIndex)));
    }

    return parts.join("");
  }

  function formatElapsedSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0.00";
    }
    return seconds.toFixed(2);
  }

  function getTableColumns(rows) {
    const columns = new Set();
    rows.forEach((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        Object.keys(row).forEach((key) => columns.add(key));
      }
    });
    return Array.from(columns);
  }

  function normalizeQueryPayload(data) {
    if (Array.isArray(data)) {
      const columns = getTableColumns(data);
      return {
        kind: "result-set",
        rows: data,
        columns,
        rowCount: data.length,
        affectedRows: undefined,
        message: `Returned ${data.length} row(s)`,
      };
    }

    if (data && typeof data === "object") {
      const rows = Array.isArray(data.rows)
        ? data.rows
        : Array.isArray(data.results)
          ? data.results
          : [];
      const columns =
        Array.isArray(data.columns) && data.columns.length > 0
          ? data.columns
          : getTableColumns(rows);

      return {
        kind: data.kind || (rows.length > 0 ? "result-set" : "command-result"),
        rows,
        columns,
        rowCount: Number.isInteger(data.rowCount) ? data.rowCount : rows.length,
        affectedRows: Number.isInteger(data.affectedRows)
          ? data.affectedRows
          : undefined,
        message: data.message || "",
      };
    }

    return {
      kind: "command-result",
      rows: [],
      columns: [],
      rowCount: 0,
      affectedRows: undefined,
      message: "",
    };
  }

  function formatCellValue(value) {
    if (value === null || value === undefined) {
      return { text: "NULL", title: "NULL", className: "cell-null" };
    }

    if (typeof value === "object") {
      const json = JSON.stringify(value);
      return {
        text: json,
        title: JSON.stringify(value, null, 2),
        className: "cell-object",
      };
    }

    const text = String(value);
    return { text, title: text, className: "" };
  }

  function getContainerGap(container) {
    const styles = window.getComputedStyle(container);
    const gapValue =
      styles.rowGap && styles.rowGap !== "normal" ? styles.rowGap : styles.gap;
    const parsed = parseFloat(gapValue || "0");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getTopLevelKeywords(query) {
    const keywords = [];
    let depth = 0;
    let i = 0;

    while (i < query.length) {
      const char = query[i];
      const nextChar = query[i + 1];

      if (char === "-" && nextChar === "-") {
        i += 2;
        while (i < query.length && query[i] !== "\n") {
          i += 1;
        }
        continue;
      }

      if (char === "/" && nextChar === "*") {
        i += 2;
        while (i < query.length && !(query[i] === "*" && query[i + 1] === "/")) {
          i += 1;
        }
        i += 2;
        continue;
      }

      if (char === "'" || char === '"' || char === "`") {
        const quote = char;
        i += 1;
        while (i < query.length) {
          if (query[i] === quote) {
            if (quote === "'" && query[i + 1] === quote) {
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (query[i] === "\\") {
            i += 2;
            continue;
          }
          i += 1;
        }
        continue;
      }

      if (/\s/.test(char)) {
        i += 1;
        continue;
      }

      if (char === "(") {
        depth += 1;
        i += 1;
        continue;
      }

      if (char === ")") {
        depth = Math.max(0, depth - 1);
        i += 1;
        continue;
      }

      if (depth === 0 && /[A-Za-z_]/.test(char)) {
        let end = i + 1;
        while (end < query.length && /[A-Za-z0-9_$]/.test(query[end])) {
          end += 1;
        }
        keywords.push(query.slice(i, end).toUpperCase());
        i = end;
        continue;
      }

      i += 1;
    }

    return keywords;
  }

  function getStatementType(query) {
    const keywords = getTopLevelKeywords(query);
    if (keywords.length === 0) {
      return "";
    }

    if (keywords[0] === "WITH") {
      for (let index = 1; index < keywords.length; index += 1) {
        const keyword = keywords[index];
        if (["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(keyword)) {
          return keyword;
        }
      }
    }

    return keywords[0];
  }

  function hasTopLevelLimit(query) {
    return getTopLevelKeywords(query).includes("LIMIT");
  }

  const utils = {
    escapeHtmlChars,
    syntaxHighlightJson,
    formatElapsedSeconds,
    getTableColumns,
    normalizeQueryPayload,
    formatCellValue,
    getContainerGap,
    getTopLevelKeywords,
    getStatementType,
    hasTopLevelLimit,
  };

  window.SQL4ALLExecutorUtils = utils;
  window.SQL4ALLSqlUtils = utils;
})();