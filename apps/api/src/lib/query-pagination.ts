export function parseBoundedQueryInteger(
  value: string | undefined,
  options: { defaultValue: number; minimum: number; maximum: number },
): number {
  if (value === undefined || value === "") return options.defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.minimum) return options.defaultValue;
  return Math.min(parsed, options.maximum);
}
