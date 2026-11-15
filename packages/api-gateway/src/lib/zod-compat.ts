import { z } from 'zod';

/**
 * PATCH schema from a create schema: every field optional, `.default()` removed.
 *
 * zod 4 applies a field's `.default()` inside `.partial()` (zod 3 did not), so
 * `Schema.partial()` would turn an omitted field into its default and a PATCH
 * would silently reset it. Omitted fields must stay omitted.
 */
export function patchSchema<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field instanceof z.ZodDefault) shape[key] = field.unwrap() as z.ZodType;
  }
  return schema.extend(shape).partial() as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}

/**
 * ISO 8601 UTC date-time as zod 3's `z.string().datetime()` accepted it: seconds
 * optional (`2026-01-01T08:00Z`). zod 4 requires the seconds.
 */
export const isoDateTime = () => z.union([z.string().datetime(), z.string().datetime({ precision: -1 })]);
