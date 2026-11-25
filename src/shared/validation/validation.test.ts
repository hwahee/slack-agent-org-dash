import { describe, expect, test } from 'bun:test';

import { fromJsonSchema, s, toJsonSchema, toValidator, ValidationError } from './index';

const validator = toValidator(
  s.strictObject({
    name: s.string().check(s.minLength(1)),
    age: s.optional(s.int().check(s.gte(0))),
  }),
);

describe('validation facade', () => {
  test('parse returns the typed value on success', () => {
    expect(validator.parse({ name: 'Ada', age: 36 })).toEqual({ name: 'Ada', age: 36 });
  });

  test('parse throws ValidationError with library-agnostic issues', () => {
    try {
      validator.parse({ name: '', age: -1 });
      throw new Error('expected ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.map((issue) => issue.path)).toContain('name');
      expect(issues.map((issue) => issue.path)).toContain('age');
      for (const issue of issues) {
        expect(typeof issue.message).toBe('string');
        expect(typeof issue.code).toBe('string');
      }
    }
  });

  test('safeParse never throws', () => {
    const ok = validator.safeParse({ name: 'Ada' });
    expect(ok).toEqual({ ok: true, value: { name: 'Ada' } });

    const bad = validator.safeParse({ name: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('name');
  });

  test('nested paths are dotted', () => {
    const nested = toValidator(s.object({ user: s.object({ email: s.string() }) }));
    const result = nested.safeParse({ user: { email: 7 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('user.email');
  });
});

describe('fromJsonSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      port: { type: 'integer', minimum: 0, maximum: 65535 },
      level: { type: 'string', enum: ['debug', 'info'] },
      delay: {
        anyOf: [
          { type: 'integer', minimum: 0 },
          {
            type: 'object',
            properties: { min: { type: 'integer' }, max: { type: 'integer' } },
            required: ['min', 'max'],
          },
        ],
      },
    },
    required: ['port', 'level'],
    additionalProperties: false,
  };

  test('validates what the JSON Schema says, and hands the same schema back', () => {
    const validator = fromJsonSchema(schema);
    expect(validator.parse({ port: 1, level: 'info', delay: { min: 1, max: 2 } })).toEqual({
      port: 1,
      level: 'info',
      delay: { min: 1, max: 2 },
    });
    const result = validator.safeParse({ port: 70_000, level: 'x', extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path).sort()).toEqual(['', 'level', 'port']);
    }
    expect(validator.safeParse({ port: 1.5, level: 'info' }).ok).toBe(false);
    expect(toJsonSchema(validator)).toEqual(schema);
  });

  test('something that is not a JSON Schema is refused with the reason', () => {
    expect(() => fromJsonSchema('str')).toThrow('invalid JSON Schema');
    expect(() => fromJsonSchema({ type: 'nope' })).toThrow('invalid JSON Schema');
    expect(() => fromJsonSchema({ type: 'object', properties: 5 })).toThrow(
      'invalid JSON Schema: (root).properties: not an object',
    );
    expect(() => fromJsonSchema({ hello: 'world' })).toThrow('no JSON Schema keyword');
  });
});
