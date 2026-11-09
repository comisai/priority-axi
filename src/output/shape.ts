// How records from Priority become rows: which columns, how values look.

import type { Field, ScreenType } from '../index/build.ts';
import { isTextForm, plainText } from './html.ts';
import { cut } from './toon.ts';

/** Default columns for lists: the key, then non-empty fields in form order, up to `max` in all. */
export const DEFAULT_COLUMNS = 4;

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

export function defaultColumns(
  type: ScreenType,
  rows: readonly Record<string, unknown>[],
  max: number = DEFAULT_COLUMNS,
): string[] {
  // Every key field is shown, even past `max`: without it a row cannot be named.
  const columns = type.key.filter((k) => type.fields.some((f) => f.name === k));
  for (const field of type.fields) {
    if (columns.length >= max) break;
    if (columns.includes(field.name) || field.internalId) continue;
    if (rows.some((row) => !isEmpty(row[field.name]))) columns.push(field.name);
  }
  return columns;
}

/** Format one value for display. Dates of DateType "Date" show as YYYY-MM-DD. */
export function formatValue(
  field: Field | undefined,
  value: unknown,
  fieldLimit: number,
): unknown {
  if (value === '' || value === undefined) return null;
  if (typeof value !== 'string') return value;
  if (field?.dateType === 'Date' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return value.slice(0, 10);
  return Number.isFinite(fieldLimit) ? cut(value, fieldLimit) : value;
}

/** A table row: exactly `columns`, empty values as null, so TOON keeps the tabular form. */
export function tableRow(
  type: ScreenType,
  row: Record<string, unknown>,
  columns: readonly string[],
  fieldLimit: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of columns) {
    out[name] = formatValue(
      type.fields.find((f) => f.name === name),
      row[name],
      fieldLimit,
    );
  }
  return out;
}

/**
 * A single record: every non-empty field in form order; internal IDs only with
 * `withIds`. The HTML of a remarks sub-screen's TEXT is shown as plain text.
 */
export function recordView(
  type: ScreenType,
  row: Record<string, unknown>,
  fieldLimit: number,
  withIds = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const textForm = isTextForm(type);
  for (const field of type.fields) {
    if (field.internalId && !withIds && !type.key.includes(field.name))
      continue;
    const raw = row[field.name];
    const value =
      textForm && field.name === 'TEXT' && typeof raw === 'string'
        ? plainText(raw)
        : raw;
    if (isEmpty(value)) continue;
    out[field.name] = formatValue(field, value, fieldLimit);
  }
  return out;
}
