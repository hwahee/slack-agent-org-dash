/**
 * Action forms from an input JSON Schema (docs/testbed/dashboard.md §1):
 * `string` (minLength, maxLength, enum), `number`/`integer` (minimum,
 * maximum), `boolean`, and a one-level `object` of those. Anything else
 * falls back to a JSON editor.
 */

export interface FormField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  required: boolean;
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export type FormSpec = { kind: 'fields'; fields: FormField[] } | { kind: 'json' };

/** What a form holds while being edited: text for text inputs, a flag for checkboxes. */
export type FormValues = Record<string, string | boolean>;

type Schema = Record<string, unknown>;

/** JSON Schema's "safe integer" bounds say nothing a person needs to see. */
const SAFE = Number.MAX_SAFE_INTEGER;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < SAFE
    ? value
    : undefined;
}

function field(name: string, schema: Schema, required: boolean): FormField | null {
  const { type } = schema;
  if (type === 'boolean') return { name, type, required };
  if (type === 'string') {
    const values = schema.enum;
    if (
      values !== undefined &&
      !(Array.isArray(values) && values.every((v) => typeof v === 'string'))
    ) {
      return null;
    }
    const minLength = finite(schema.minLength);
    const maxLength = finite(schema.maxLength);
    return {
      name,
      type,
      required,
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(values === undefined ? {} : { enum: values }),
    };
  }
  if (type === 'number' || type === 'integer') {
    const minimum = finite(schema.minimum);
    const maximum = finite(schema.maximum);
    return {
      name,
      type,
      required,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
  }
  return null;
}

export function formSpec(schema: Schema): FormSpec {
  if (schema.type !== 'object') return { kind: 'json' };
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const next = field(name, property, required.has(name));
    if (!next) return { kind: 'json' };
    fields.push(next);
  }
  return { kind: 'fields', fields };
}

export function initialValues(fields: readonly FormField[]): FormValues {
  return Object.fromEntries(
    fields.map((entry) => [
      entry.name,
      entry.type === 'boolean' ? false : entry.enum && entry.required ? (entry.enum[0] ?? '') : '',
    ]),
  );
}

/**
 * The input to send: numbers parsed, empty optional fields left out. A field
 * that cannot be read (not a number, required but empty) is an error; ranges
 * and lengths are left to the server, which says what is wrong.
 */
export function formInput(
  fields: readonly FormField[],
  values: FormValues,
): { input: Record<string, unknown>; errors: Record<string, 'required' | 'number' | 'integer'> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, 'required' | 'number' | 'integer'> = {};
  for (const entry of fields) {
    const raw = values[entry.name];
    if (entry.type === 'boolean') {
      input[entry.name] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw : '';
    if (text === '') {
      if (entry.required && entry.type !== 'string') errors[entry.name] = 'required';
      else if (entry.required) input[entry.name] = '';
      continue;
    }
    if (entry.type === 'string') {
      input[entry.name] = text;
      continue;
    }
    const number = Number(text);
    if (!Number.isFinite(number)) errors[entry.name] = 'number';
    else if (entry.type === 'integer' && !Number.isInteger(number)) errors[entry.name] = 'integer';
    else input[entry.name] = number;
  }
  return { input, errors };
}
