/**
 * What the fake external core (./fake-core.ts) answers to `initialize` —
 * shared with the tests that compare it with the manifest.
 */

const faultRule = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    match: { type: 'object' },
    probability: { type: 'number', minimum: 0, maximum: 1 },
    delayMs: { type: 'integer', minimum: 0 },
    disconnect: { type: 'boolean' },
    times: { type: 'integer', minimum: 1 },
  },
  required: ['id'],
};

export function fakeInitializeResult(
  mode: string,
  coreId: string,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    autoStart: { type: 'boolean' },
    eventLevel: { type: 'string', enum: ['debug', 'info'] },
    faults: { type: 'array', items: faultRule },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  };
  if (mode === 'reserved-field') properties.replicas = { type: 'integer' };
  const prefix = coreId.toUpperCase().replaceAll('-', '_');
  const autoStart = env[`${prefix}_AUTO_START`];
  return {
    protocolVersion: '1',
    kind: mode === 'wrong-kind' ? 'active' : 'passive',
    title: 'Fake core',
    configSchema: {
      type: 'object',
      properties,
      required: ['autoStart', 'eventLevel', 'faults', 'limit'],
      additionalProperties: false,
    },
    defaultConfig: {
      autoStart: autoStart !== 'false',
      eventLevel: 'info',
      faults: [],
      limit: Number(env[`${prefix}_LIMIT`] ?? 5),
    },
    actions: {
      echo: {
        title: 'Echo',
        description: 'Answers with the text and the replica id.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
        },
        outputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, replica: { type: 'string' } },
          required: ['text', 'replica'],
        },
        mutating: true,
      },
      emit: {
        title: 'Emit',
        description: 'Sends one event.',
        inputSchema: {
          type: 'object',
          properties: { kind: { type: 'string' }, level: { type: 'string' } },
        },
        outputSchema: { type: 'object' },
        mutating: false,
      },
      fault: {
        title: 'Fault',
        description: 'Sends one fault notification.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        mutating: false,
      },
      fail: {
        title: 'Fail',
        description: 'Fails with the given error code.',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
        outputSchema: { type: 'object' },
        mutating: false,
      },
      stderr: {
        title: 'Stderr',
        description: 'Writes a line to stderr.',
        inputSchema: {
          type: 'object',
          properties: { line: { type: 'string' } },
          required: ['line'],
        },
        outputSchema: { type: 'object' },
        mutating: false,
      },
      seen: {
        title: 'Seen',
        description: 'The seeds and Run ids it was given.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        mutating: false,
      },
    },
    faults: ['delay', 'disconnect'],
  };
}
