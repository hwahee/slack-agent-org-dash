/**
 * Checking an external core's `initialize` answer
 * (docs/testbed/external-core-protocol.md §4.1) and turning its JSON Schemas
 * into validators. Any problem is a sentence for the core's `detail`.
 */
import type { FaultKind } from '@shared/testbed/core';
import { fromJsonSchema, type Validator } from '@shared/validation';

import { GLUE_KEYS, type ExternalCoreDeclaration } from './define';

export const PROTOCOL_VERSION = '1';

const FAULT_KINDS: readonly FaultKind[] = ['delay', 'error', 'disconnect', 'corrupt'];
const COMMON_FIELDS = ['autoStart', 'eventLevel', 'faults'] as const;
const SURFACES = ['rest', 'mcp', 'ui'] as const;

interface ExternalAction {
  title: string;
  description: string;
  mutating: boolean;
  surfaces: ('rest' | 'mcp' | 'ui')[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  input: Validator<unknown>;
  output: Validator<unknown>;
}

/** What a healthy `initialize` answer gives the glue. */
export interface CoreSpec {
  kind: string;
  title: string;
  configSchema: Record<string, unknown>;
  config: Validator<unknown>;
  defaultConfig: Record<string, unknown>;
  actions: Record<string, ExternalAction>;
  faults: FaultKind[];
  /** The answer as received — replicas must all give the same one. */
  raw: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertyNames(schema: Record<string, unknown>): string[] {
  return isObject(schema.properties) ? Object.keys(schema.properties) : [];
}

/** The spec, or a sentence saying why the answer cannot be used. */
export function checkInitialize(
  result: unknown,
  declaration: ExternalCoreDeclaration,
): CoreSpec | string {
  if (!isObject(result)) return 'initialize answered with something that is not an object';
  const { protocolVersion, kind, title, configSchema, defaultConfig, actions, faults } = result;
  if (protocolVersion !== PROTOCOL_VERSION) {
    return `protocolVersion ${JSON.stringify(protocolVersion)} is not "${PROTOCOL_VERSION}"`;
  }
  if (kind !== declaration.kind) {
    return `kind ${JSON.stringify(kind)} differs from the declared '${declaration.kind}'`;
  }
  if (!isObject(configSchema)) return 'configSchema is not a JSON Schema object';
  const reserved = propertyNames(configSchema).filter((name) =>
    (GLUE_KEYS as readonly string[]).includes(name),
  );
  if (reserved.length > 0) {
    return `configSchema uses fields the glue reserves: ${reserved.join(', ')}`;
  }
  const missing = COMMON_FIELDS.filter((name) => !propertyNames(configSchema).includes(name));
  if (missing.length > 0) return `configSchema lacks the common fields: ${missing.join(', ')}`;
  let config: Validator<unknown>;
  try {
    config = fromJsonSchema(configSchema);
  } catch (error) {
    return `configSchema: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isObject(defaultConfig)) return 'defaultConfig is not an object';
  if (
    !Array.isArray(faults) ||
    !faults.every((fault) => FAULT_KINDS.includes(fault as FaultKind))
  ) {
    return `faults must be a list of ${FAULT_KINDS.join(', ')}`;
  }
  if (!isObject(actions)) return 'actions is not an object';

  const checked: Record<string, ExternalAction> = {};
  for (const [name, action] of Object.entries(actions)) {
    if (!isObject(action)) return `action ${name} is not an object`;
    const { inputSchema, outputSchema, mutating, surfaces } = action;
    if (typeof action.title !== 'string' || typeof action.description !== 'string') {
      return `action ${name}: title and description must be strings`;
    }
    if (typeof mutating !== 'boolean') return `action ${name}: mutating must be a boolean`;
    if (!isObject(inputSchema) || !isObject(outputSchema)) {
      return `action ${name}: inputSchema and outputSchema must be JSON Schema objects`;
    }
    if (propertyNames(inputSchema).includes('replica')) {
      return `action ${name}: the input property 'replica' is reserved`;
    }
    if (
      surfaces !== undefined &&
      !(Array.isArray(surfaces) && surfaces.every((surface) => SURFACES.includes(surface as never)))
    ) {
      return `action ${name}: surfaces must be a list of rest, mcp, ui`;
    }
    try {
      checked[name] = {
        title: action.title,
        description: action.description,
        mutating,
        surfaces: (surfaces as ExternalAction['surfaces'] | undefined) ?? [...SURFACES],
        inputSchema,
        outputSchema,
        input: fromJsonSchema(inputSchema),
        output: fromJsonSchema(outputSchema),
      };
    } catch (error) {
      return `action ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    kind: declaration.kind,
    title: typeof title === 'string' ? title : declaration.title,
    configSchema,
    config,
    defaultConfig,
    actions: checked,
    faults: faults as FaultKind[],
    raw: JSON.stringify({ protocolVersion, kind, configSchema, actions, faults }),
  };
}
