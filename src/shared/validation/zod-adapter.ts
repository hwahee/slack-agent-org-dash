/**
 * zod/mini adapter for the validation facade.
 *
 * This is the ONLY file in the repository that may import zod (enforced by
 * ESLint `no-restricted-imports`). To swap the schema library:
 *
 *   1. Write a new adapter (e.g. `yup-adapter.ts`) exposing an equivalent
 *      `toValidator` and schema-builder export.
 *   2. Re-point the re-exports in ./index.ts and update the (small, colocated)
 *      schema definition sites.
 *
 * Consumers of `Validator<T>` are untouched by such a swap.
 */
import { fromJSONSchema } from 'zod';
import * as z from 'zod/mini';

import {
  ValidationError,
  type ValidationIssue,
  type ValidationResult,
  type Validator,
} from './core';

/**
 * Schema builder namespace, re-exported under a neutral name so definition
 * sites read `s.object({ … })` rather than being visibly tied to zod.
 */
export { z as s };

/** Minimal structural view of a zod schema — keeps us off zod's internal type names. */
interface ZodLikeSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly ZodLikeIssue[] } };
}

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

function toIssues(issues: readonly ZodLikeIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code ?? 'invalid',
  }));
}

/** The schema behind each validator, for {@link toJsonSchema}. */
const schemas = new WeakMap<Validator<unknown>, ZodLikeSchema<unknown>>();

/** Wraps a zod schema into the library-agnostic {@link Validator} contract. */
export function toValidator<T>(schema: ZodLikeSchema<T>): Validator<T> {
  const validator: Validator<T> = {
    parse(input: unknown): T {
      const result = schema.safeParse(input);
      if (!result.success) throw new ValidationError(toIssues(result.error.issues));
      return result.data;
    },
    safeParse(input: unknown): ValidationResult<T> {
      const result = schema.safeParse(input);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, issues: toIssues(result.error.issues) };
    },
  };
  schemas.set(validator, schema);
  return validator;
}

/** JSON Schemas given to {@link fromJsonSchema}, handed back unchanged by {@link toJsonSchema}. */
const jsonSchemas = new WeakMap<Validator<unknown>, Record<string, unknown>>();

const SCHEMA_KEYWORDS = ['type', 'properties', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', '$ref'];

/** A shallow sanity check zod's converter does not make (e.g. `properties: 5`). */
function jsonSchemaProblem(schema: unknown, path = '(root)'): string | null {
  if (typeof schema === 'boolean') return null;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return `${path}: not a JSON Schema object`;
  }
  const node = schema as Record<string, unknown>;
  if (path === '(root)' && !SCHEMA_KEYWORDS.some((key) => key in node)) {
    return `${path}: no JSON Schema keyword (${SCHEMA_KEYWORDS.join(', ')})`;
  }
  if ('properties' in node) {
    const properties = node.properties;
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      return `${path}.properties: not an object`;
    }
    for (const [key, child] of Object.entries(properties)) {
      const problem = jsonSchemaProblem(child, `${path}.properties.${key}`);
      if (problem) return problem;
    }
  }
  if ('items' in node) {
    const problem = jsonSchemaProblem(node.items, `${path}.items`);
    if (problem) return problem;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (key in node && !Array.isArray(node[key])) return `${path}.${key}: not an array`;
  }
  if ('required' in node && !Array.isArray(node.required)) return `${path}.required: not an array`;
  return null;
}

/**
 * A validator from a JSON Schema (draft 2020-12) — for schemas that arrive at
 * run time, e.g. from an external core's `initialize`. Throws an `Error`
 * saying what is wrong when `schema` is not a JSON Schema this can use.
 * {@link toJsonSchema} gives the same schema back.
 */
export function fromJsonSchema(schema: unknown): Validator<unknown> {
  const problem = jsonSchemaProblem(schema);
  if (problem) throw new Error(`invalid JSON Schema: ${problem}`);
  let converted: ZodLikeSchema<unknown>;
  try {
    converted = fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]);
  } catch (error) {
    throw new Error(
      `invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  const validator = toValidator(converted);
  if (typeof schema === 'object' && schema !== null) {
    jsonSchemas.set(validator, structuredClone(schema as Record<string, unknown>));
  }
  return validator;
}

/**
 * JSON Schema of what a validator accepts — for documents that describe an
 * input to other programs (e.g. a testbed manifest). `{}` for a validator not
 * made by {@link toValidator}.
 */
export function toJsonSchema(validator: Validator<unknown>): Record<string, unknown> {
  const original = jsonSchemas.get(validator);
  if (original) return structuredClone(original);
  const schema = schemas.get(validator);
  if (!schema) return {};
  return z.toJSONSchema(schema as unknown as Parameters<typeof z.toJSONSchema>[0], {
    io: 'input',
    unrepresentable: 'any',
  });
}
