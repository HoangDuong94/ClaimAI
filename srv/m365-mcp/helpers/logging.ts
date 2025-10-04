// srv/m365-mcp/helpers/logging.ts
// Provides defensive JSON serialization for logging without crashing on circular structures.

export function safeJson(value: unknown, max = 4000): string {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const output = typeof serialized === 'string' ? serialized : String(serialized);
    return output.length > max ? `${output.slice(0, max)} ...[truncated]` : output;
  } catch (error) {
    try {
      return String(value);
    } catch {
      return '[unprintable]';
    }
  }
}
