/**
 * Suppress Node's `node:sqlite` experimental warning.
 *
 * It would otherwise prefix the output of every command. The dependency is a
 * deliberate choice — documented in the README — and this filter is narrow
 * enough that any other warning still gets through.
 *
 * Imported for its side effect by the CLI entry point, and it must stay the
 * first import there. Node emits the warning when the builtin is *linked*,
 * which happens before any module body runs, so this only works because
 * `src/db/index.ts` loads `node:sqlite` with `require` during evaluation
 * rather than importing it statically. Change that back to a static import
 * and the warning reappears no matter what this file does.
 *
 * Remove both once `node:sqlite` is marked stable.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
