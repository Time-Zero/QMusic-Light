import type { DbValue } from '@qmusic/shared-types';

export interface DbClient {
  select(sql: string, params?: DbValue[]): Promise<Record<string, DbValue>[]>;
  execute(sql: string, params?: DbValue[]): Promise<number>;
}

export function toBool(value: DbValue | undefined): boolean {
  return value === 1 || value === '1';
}

export function toNum(value: DbValue | undefined, fallback = 0): number {
  return typeof value === 'number' ? value : Number(value ?? fallback) || fallback;
}

export function toStr(value: DbValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
