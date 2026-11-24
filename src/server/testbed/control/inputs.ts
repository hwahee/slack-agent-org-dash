/**
 * Inputs of the control-service functions, validated the same way whichever
 * adapter (REST, MCP) they came through. MCP also publishes them as the tools'
 * JSON Schemas, so the descriptions here are what agents read.
 */
import { eventFilterSchema } from '@shared/testbed/events';
import { s, toValidator } from '@shared/validation';

const label = s.string().check(s.minLength(1), s.maxLength(200));
const coreId = s.string().check(s.minLength(1));

export const startRunInput = toValidator(
  s.object({
    label,
    seed: s.optional(s.string().check(s.minLength(1), s.maxLength(200))),
    configOverrides: s.optional(s.record(s.string(), s.record(s.string(), s.unknown()))),
    endActive: s.optional(s.boolean()),
  }),
);

export const configPatchInput = toValidator(s.record(s.string(), s.unknown()));

/** `timeoutMs` above the cap is cut to it by the service, not refused. */
export const waitInput = toValidator(
  s.object({
    filter: s._default(eventFilterSchema, {}),
    count: s.optional(s.int().check(s.gte(1), s.lte(500))),
    timeoutMs: s.optional(s.int().check(s.gte(0))),
  }),
);

export const checkInput = toValidator(
  s.object({
    filter: s._default(eventFilterSchema, {}),
    expect: s._default(
      s.object({
        count: s.optional(s.string().check(s.regex(/^(==|>=|<=)\d+$/))),
        none: s.optional(s.literal(true)),
      }),
      {},
    ),
    label: s.optional(label),
  }),
);

export const emptyInput = toValidator(s.object({}));
export const coreInput = toValidator(s.object({ core: coreId }));
export const optionalCoreInput = toValidator(s.object({ core: s.optional(coreId) }));
export const setConfigInput = toValidator(
  s.object({ core: coreId, patch: s.record(s.string(), s.unknown()) }),
);
export const eventIdInput = toValidator(s.object({ id: s.string().check(s.minLength(1)) }));
export const exportRunInput = toValidator(
  s.object({ runId: s.optional(s.string().check(s.minLength(1))) }),
);
