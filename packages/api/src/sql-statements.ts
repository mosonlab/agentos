/**
 * Cuts a fixture's setup SQL into statements a driver will take one at a time.
 *
 * Prisma sends raw SQL as a prepared statement and PostgreSQL refuses more than
 * one command in one of those — `cannot insert multiple commands into a
 * prepared statement`. The migration fixtures write their setup as one readable
 * block of DDL and inserts, and that block used to be handed to a spawned
 * `prisma db execute`, which accepts many. Running it in-process instead is
 * worth about two seconds of process startup per call, and this is the part
 * that has to change to make that possible.
 *
 * Splitting on every `;` would also split inside a string literal, so this
 * tracks quoting instead of scanning for the character. Constructs these
 * fixtures do not use are refused rather than guessed at: a dollar-quoted body
 * needs tag matching, and a mis-split there would corrupt setup silently rather
 * than fail it. An unterminated literal is refused for the same reason — the
 * remainder would otherwise be swallowed into a statement nobody wrote.
 */
export const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let index = 0;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed !== "") statements.push(trimmed);
    current = "";
  };

  while (index < sql.length) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }

    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new Error("fixture SQL has an unterminated block comment");
      index = end + 2;
      continue;
    }

    if (character === "$") {
      // `$$body$$` and `$tag$body$tag$` both need the closing tag matched, and
      // no fixture here has one. Refusing keeps the cheap scanner honest.
      if (/^\$[A-Za-z_]*\$/u.test(sql.slice(index))) {
        throw new Error("fixture SQL uses dollar quoting, which this splitter deliberately does not handle");
      }
    }

    if (character === "'" || character === '"') {
      const closing = sql.indexOf(character, index + 1);
      if (closing === -1) throw new Error(`fixture SQL has an unterminated ${character === "'" ? "string" : "identifier"}`);
      // A doubled quote is the escape, and closing then reopening on the next
      // character is exactly how it is consumed.
      current += sql.slice(index, closing + 1);
      index = closing + 1;
      continue;
    }

    if (character === ";") {
      push();
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  push();
  return statements;
};
