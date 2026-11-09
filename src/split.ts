export interface Statement {
  /** Statement text without the terminating `;`, leading whitespace trimmed. */
  text: string;
  /** 1-based line of the statement's first character in the original input. */
  startLine: number;
  /** 1-based column of the statement's first character. */
  startColumn: number;
}

const GO_LINE = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?=\r?\n|$)/i;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Splits DDL into statements on `;` outside string literals, quoted identifiers,
 * `--` / `/* *\/` comments and `$tag$` bodies. A line holding only `GO` (T-SQL) is
 * a separator too. Statements that contain only comments or whitespace are dropped.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  const n = sql.length;

  let i = 0;
  let line = 1;
  let col = 1;

  // Current statement.
  let start = -1; // index of the first non-whitespace char, -1 while none
  let startLine = 1;
  let startColumn = 1;
  let hasCode = false; // saw something other than comments

  const flush = (end: number) => {
    if (start >= 0 && hasCode) {
      const text = sql.slice(start, end).trimEnd();
      if (text !== "") out.push({ text, startLine, startColumn });
    }
    start = -1;
    hasCode = false;
  };

  const mark = (code: boolean) => {
    if (start < 0) {
      start = i;
      startLine = line;
      startColumn = col;
    }
    if (code) hasCode = true;
  };

  // Advance over sql[i], keeping line/col current.
  const step = () => {
    if (sql[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
  };
  const stepTo = (j: number) => {
    while (i < j && i < n) step();
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // `GO` on its own line, checked at the start of each line.
    if (col === 1) {
      const m = GO_LINE.exec(sql.slice(i, i + 64));
      if (m) {
        flush(i);
        stepTo(i + m[0].length);
        continue;
      }
    }

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      step();
      continue;
    }

    // -- line comment
    if (ch === "-" && next === "-") {
      mark(false);
      while (i < n && sql[i] !== "\n") step();
      continue;
    }

    // /* block comment */ (nesting allowed, as in PostgreSQL)
    if (ch === "/" && next === "*") {
      mark(false);
      let depth = 0;
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          stepTo(i + 2);
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          stepTo(i + 2);
          if (depth === 0) break;
        } else {
          step();
        }
      }
      continue;
    }

    if (ch === ";") {
      flush(i);
      step();
      continue;
    }

    mark(true);

    // 'string' — '' escapes; E'...' also allows backslash escapes.
    if (ch === "'") {
      const prev = i > 0 ? sql[i - 1] : "";
      const before = i > 1 ? sql[i - 2]! : "";
      const backslashEscapes =
        (prev === "E" || prev === "e") && !IDENT_CHAR.test(before);
      step();
      while (i < n) {
        const c = sql[i];
        if (backslashEscapes && c === "\\") {
          stepTo(i + 2);
        } else if (c === "'") {
          if (sql[i + 1] === "'") stepTo(i + 2);
          else {
            step();
            break;
          }
        } else {
          step();
        }
      }
      continue;
    }

    // "identifier" or `identifier` — doubled quote escapes.
    if (ch === '"' || ch === "`") {
      step();
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) stepTo(i + 2);
          else {
            step();
            break;
          }
        } else {
          step();
        }
      }
      continue;
    }

    // $tag$ ... $tag$ (not when glued to an identifier, e.g. `a$b$`).
    if (ch === "$" && !(i > 0 && IDENT_CHAR.test(sql[i - 1]!))) {
      const m = DOLLAR_TAG.exec(sql.slice(i, i + 128));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        stepTo(close < 0 ? n : close + tag.length);
        continue;
      }
    }

    step();
  }

  flush(n);
  return out;
}
