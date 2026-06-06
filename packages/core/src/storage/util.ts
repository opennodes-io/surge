import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const now = (): number => Date.now();

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** libsql returns INTEGER as number; normalise nullable numerics. */
export function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

export function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function bool(value: unknown): boolean {
  return num(value) !== 0;
}
