const TERMINAL_MAX_OUTPUT_CHARS = 240_000;

export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

export const trimTerminalOutput = (value) => {
  if (value.length <= TERMINAL_MAX_OUTPUT_CHARS) {
    return value;
  }
  return value.slice(value.length - TERMINAL_MAX_OUTPUT_CHARS);
};
