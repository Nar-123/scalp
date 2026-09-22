export function nowMs(): number {
  return Date.now();
}

export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function secondsBetween(startMs: number, endMs: number): number {
  return (endMs - startMs) / 1000;
}
