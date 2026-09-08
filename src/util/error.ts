/**
 * Type-safe error message extraction.
 *
 * Returns `err.message` when `err` is an `Error` instance, otherwise
 * `String(err)` for unknown throwables (strings, numbers, objects).
 *
 * @example
 * catch (err) {
 *   res.status(500).json({ error: "Failed", message: errorMessage(err) });
 * }
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
