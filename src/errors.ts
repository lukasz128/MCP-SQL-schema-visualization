export type SchemaErrorCode =
  | "INVALID_ARGS"
  | "INPUT"
  | "PARSE"
  | "NO_TABLES";

/** An expected failure, reported to the caller as an `isError: true` tool result. */
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly line?: number;
  readonly column?: number;

  constructor(
    code: SchemaErrorCode,
    message: string,
    position: { line?: number; column?: number } = {},
  ) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
    if (position.line !== undefined) this.line = position.line;
    if (position.column !== undefined) this.column = position.column;
  }
}
