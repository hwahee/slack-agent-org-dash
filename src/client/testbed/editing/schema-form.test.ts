import { describe, expect, test } from 'bun:test';

import { formInput, formSpec, initialValues } from './schema-form';

const SAFE = Number.MAX_SAFE_INTEGER;

describe('formSpec', () => {
  test('each supported type becomes a field with its limits', () => {
    expect(
      formSpec({
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 4096 },
          mode: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'integer', minimum: 0, maximum: 9 },
          ratio: { type: 'number', minimum: -SAFE, maximum: SAFE },
          on: { type: 'boolean' },
        },
        required: ['text', 'mode'],
      }),
    ).toEqual({
      kind: 'fields',
      fields: [
        { name: 'text', type: 'string', required: true, minLength: 1, maxLength: 4096 },
        { name: 'mode', type: 'string', required: true, enum: ['a', 'b'] },
        { name: 'count', type: 'integer', required: false, minimum: 0, maximum: 9 },
        { name: 'ratio', type: 'number', required: false },
        { name: 'on', type: 'boolean', required: false },
      ],
    });
  });

  test('anything else falls back to the JSON editor', () => {
    expect(formSpec({ type: 'string' })).toEqual({ kind: 'json' });
    expect(formSpec({})).toEqual({ kind: 'json' });
    expect(
      formSpec({ type: 'object', properties: { nested: { type: 'object', properties: {} } } }),
    ).toEqual({ kind: 'json' });
    expect(
      formSpec({ type: 'object', properties: { list: { type: 'array', items: {} } } }),
    ).toEqual({ kind: 'json' });
    expect(
      formSpec({ type: 'object', properties: { either: { anyOf: [{ type: 'string' }] } } }),
    ).toEqual({ kind: 'json' });
  });

  test('an object with no properties is an empty form', () => {
    expect(formSpec({ type: 'object', properties: {} })).toEqual({ kind: 'fields', fields: [] });
  });
});

describe('formInput', () => {
  const spec = formSpec({
    type: 'object',
    properties: {
      text: { type: 'string' },
      mode: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      on: { type: 'boolean' },
    },
    required: ['text', 'mode', 'count'],
  });
  const fields = spec.kind === 'fields' ? spec.fields : [];

  test('starting values: empty text, the first enum value when required, unchecked', () => {
    expect(initialValues(fields)).toEqual({ text: '', mode: 'a', count: '', ratio: '', on: false });
  });

  test('numbers are parsed, empty optional fields are left out', () => {
    expect(formInput(fields, { text: 'hi', mode: 'b', count: '3', ratio: '', on: true })).toEqual({
      input: { text: 'hi', mode: 'b', count: 3, on: true },
      errors: {},
    });
  });

  test('unreadable numbers and missing required numbers are errors', () => {
    expect(
      formInput(fields, { text: '', mode: 'a', count: '', ratio: 'x', on: false }).errors,
    ).toEqual({ count: 'required', ratio: 'number' });
    expect(
      formInput(fields, { text: '', mode: 'a', count: '1.5', ratio: '', on: false }).errors,
    ).toEqual({
      count: 'integer',
    });
  });
});
