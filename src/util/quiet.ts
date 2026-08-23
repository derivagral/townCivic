/**
 * Suppress Node's `node:sqlite` experimental warning.
 *
 * It fires on every database open, so it would prefix the output of every
 * command. The dependency is a deliberate choice — documented in the README —
 * and this filter is narrow enough that any other warning still gets through.
 *
 * Imported for its side effect by the CLI entry point, before any database is
 * opened. Remove it once `node:sqlite` is marked stable.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
