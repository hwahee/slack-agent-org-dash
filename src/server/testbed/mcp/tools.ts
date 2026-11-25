/**
 * The MCP tools (docs/testbed/control-plane.md §4): the 16 common tools and
 * one tool per core action exposed to MCP. Every tool only calls a control
 * service function and words its result; nothing is implemented here.
 */
import {
  eventFilterValidator,
  toEventLine,
  type Caller,
  type TestbedEvent,
} from '@shared/testbed/events';
import type { RunMeta } from '@shared/testbed/runs';
import { toJsonSchema, ValidationError, type Validator } from '@shared/validation';

import { NotFoundError } from '../../lib/errors';
import { TestbedError } from '../errors';
import {
  checkInput,
  coreInput,
  coreLogInput,
  emptyInput,
  eventIdInput,
  exportRunInput,
  optionalCoreInput,
  setConfigInput,
  startRunInput,
  waitInput,
} from '../control/inputs';
import type { ControlService } from '../control/service';
import { expectedText } from '../runs/check';
import {
  coreLogText,
  coreText,
  endedRunText,
  eventLinesText,
  eventLineText,
  leaseText,
  runText,
} from './format';

const ALL_CORES = '_all';
const LOCKED = ' (제어 락 필요)';
const READ_ONLY = ' (읽기 전용)';

interface ToolOutput {
  text: string;
  structured: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  call(input: unknown, caller: Caller): Promise<ToolOutput>;
}

/** What `tools/call` returns. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

/** MCP wants an object schema at the top of every tool. */
function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest.type === 'object' ? rest : { type: 'object' };
}

function tool<T>(definition: {
  name: string;
  description: string;
  input: Validator<T>;
  readOnly: boolean;
  run(input: T, caller: Caller): Promise<ToolOutput>;
}): McpTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: objectSchema(toJsonSchema(definition.input)),
    readOnly: definition.readOnly,
    call: (input, caller) => definition.run(definition.input.parse(input ?? {}), caller),
  };
}

/** A Run for `testbed_info`: who, when, which seed — not the config snapshot. */
function runBrief({
  configSnapshot: _snapshot,
  ...rest
}: RunMeta): Omit<RunMeta, 'configSnapshot'> {
  return rest;
}

function plain(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function commonTools(control: ControlService): McpTool[] {
  const coreOperation = (name: 'start' | 'stop' | 'reset', what: string) =>
    tool({
      name,
      description: `${what} \`core\`를 생략하면 모든 코어. 결과로 코어마다 상태와 데이터면 주소를 돌려줌.${LOCKED}`,
      input: optionalCoreInput,
      readOnly: false,
      run: async ({ core }, caller) => {
        const cores = await control[name](core ?? ALL_CORES, caller);
        return {
          text: cores.map((status) => coreText(status, [])).join('\n'),
          structured: { cores },
        };
      },
    });

  return [
    tool({
      name: 'testbed_info',
      description: `테스트베드 요약: 이름·버전·instanceId, 코어마다 상태·데이터면 주소(제품이 붙을 곳)·액션 이름, 열린 Run, 제어 락 보유자. 처음에 한 번 부름.${READ_ONLY}`,
      input: emptyInput,
      readOnly: true,
      run: (_input, caller) => {
        const manifest = control.getManifest(caller);
        const status = control.getStatus(caller);
        const cores = manifest.cores.map((core) => {
          const replicas = status.cores.find((entry) => entry.id === core.id)?.replicas;
          return {
            id: core.id,
            kind: core.kind,
            state: core.state,
            endpoints: core.endpoints,
            actions: core.actions.map((action) => action.name),
            ...(core.external
              ? {
                  external: true,
                  replicas: (replicas ?? []).map(({ id, state, pid, restarts }) => ({
                    id,
                    state,
                    ...(pid === undefined ? {} : { pid }),
                    restarts,
                  })),
                }
              : {}),
          };
        });
        const lines = [
          `${manifest.name} ${manifest.version} (instance ${manifest.instanceId})`,
          ...status.cores.map((core) =>
            coreText(core, cores.find((entry) => entry.id === core.id)?.actions ?? []),
          ),
          runText(status.run),
          leaseText(status.lease),
        ];
        return Promise.resolve({
          text: lines.join('\n'),
          structured: {
            name: manifest.name,
            version: manifest.version,
            instanceId: manifest.instanceId,
            cores,
            // The Run without its configSnapshot (every core's config): that
            // is in the Run's own record (REST GET /runs/current).
            run: status.run === null ? null : runBrief(status.run),
            lease: status.lease,
          },
        });
      },
    }),
    tool({
      name: 'get_core_log',
      description: `외부 코어 프로세스의 stderr 최근 50줄(비밀값은 가림), 복제마다. \`replica\`(예: "r1")를 주면 그 복제만. in-proc 코어는 빈 목록과 안내 문장.${READ_ONLY}`,
      input: coreLogInput,
      readOnly: true,
      run: ({ core, replica }, caller) => {
        const log = control.getCoreLog(core, caller, replica);
        return Promise.resolve({ text: coreLogText(log), structured: { ...log } });
      },
    }),
    tool({
      name: 'get_config',
      description: `코어 하나의 현재 설정 객체(결함 규칙 \`faults\` 포함).${READ_ONLY}`,
      input: coreInput,
      readOnly: true,
      run: ({ core }, caller) => {
        const config = control.getConfig(core, caller);
        return Promise.resolve({ text: JSON.stringify(config), structured: { ...config } });
      },
    }),
    tool({
      name: 'set_config',
      description: `코어 설정의 부분 변경(\`patch\`의 필드만 바뀜, \`faults\`는 통째로 바뀜). 결과 \`applied\`는 바로 적용, \`restart-required\`는 저장됐고 stop → start 후 적용. 잘못된 값이나 설정에 없는 키는 VALIDATION_ERROR(아무것도 바뀌지 않음).${LOCKED}`,
      input: setConfigInput,
      readOnly: false,
      run: async ({ core, patch }, caller) => {
        const out = await control.setConfig(core, patch, caller);
        return {
          text:
            out.result === 'applied'
              ? `${core} config applied`
              : `${core} config saved; restart-required: stop → start 하면 적용됨`,
          structured: out,
        };
      },
    }),
    coreOperation('start', '코어를 시작함(이미 running이면 그대로).'),
    coreOperation('stop', '코어를 멈춤. 열린 데이터면 연결이 모두 닫힘.'),
    coreOperation(
      'reset',
      '코어 상태를 초기화함(연결을 닫고 카운터·순번·결함 times를 0으로). 리스너는 유지.',
    ),
    tool({
      name: 'start_run',
      description: `Run(시험 한 번의 기록 단위)을 시작. 이후 이벤트에 runId가 붙음. \`seed\`(생략하면 무작위)로 결함 판정이 재현됨. \`configOverrides\`({코어: 패치})는 Run 동안만 적용되고 닫힐 때 되돌아감. 이미 열린 Run이 있으면 RUN_ACTIVE; \`endActive: true\`면 그 Run을 닫고 시작.${LOCKED}`,
      input: startRunInput,
      readOnly: false,
      run: async (input, caller) => {
        const run = await control.startRun(
          {
            label: input.label,
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            ...(input.configOverrides === undefined
              ? {}
              : { configOverrides: input.configOverrides }),
            ...(input.endActive === undefined ? {} : { endActive: input.endActive }),
          },
          caller,
        );
        return {
          text: `Run ${run.runId} '${run.label}' started (seed ${run.seed})`,
          structured: { ...run },
        };
      },
    }),
    tool({
      name: 'end_run',
      description: `열린 Run을 닫고 요약(kind·level별 건수, 오류 상위, check 결과)을 돌려줌. 열린 Run이 없으면 NOT_FOUND.${LOCKED}`,
      input: emptyInput,
      readOnly: false,
      run: async (_input, caller) => {
        const run = await control.endRun(caller);
        return { text: endedRunText(run), structured: { ...run } };
      },
    }),
    tool({
      name: 'query_events',
      description: `이벤트 조회. 오래된 것부터 한 줄씩(payload 없음), 기본 50건·상한 500건(\`limit\`). 이어 받으려면 \`nextCursor\`를 \`after\`로. \`kind\`는 접두사, \`level\`은 그 수준 이상, \`text\`는 summary 부분 일치, \`runId\`는 Run id 또는 'current'. 전체 payload는 get_event.${READ_ONLY}`,
      input: eventFilterValidator,
      readOnly: true,
      run: async (filter, caller) => {
        const page = await control.queryEvents(filter, caller);
        const events = page.events.map(toEventLine);
        return {
          text: `${eventLinesText(events)}\nnext cursor: ${page.cursor ?? '(none)'} · ${events.length} of ${page.total}`,
          structured: { events, nextCursor: page.cursor, total: page.total },
        };
      },
    }),
    tool({
      name: 'get_event',
      description: `이벤트 하나의 전체(봉투와 payload). \`id\`는 query_events의 id. 링버퍼에서 밀려난 이벤트는 NOT_FOUND.${READ_ONLY}`,
      input: eventIdInput,
      readOnly: true,
      run: ({ id }, caller) => {
        const event: TestbedEvent = control.getEvent(id, caller);
        return Promise.resolve({
          text: `${eventLineText(toEventLine(event))}\n${JSON.stringify(event.payload, null, 2)}`,
          structured: { ...event },
        });
      },
    }),
    tool({
      name: 'wait_for',
      description: `\`filter\`에 맞는 이벤트가 \`count\`건(기본 1) 올 때까지 기다림. \`after\`가 없으면 부른 뒤부터 셈. \`timeoutMs\` 기본 30000, 상한 120000(넘으면 120000으로 잘림). 시간이 지나면 오류가 아니라 지금까지의 결과와 \`timedOut: true\`.${READ_ONLY}`,
      input: waitInput,
      readOnly: true,
      run: async (input, caller) => {
        const count = input.count ?? 1;
        const out = await control.waitFor(
          {
            filter: input.filter,
            count,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          },
          caller,
        );
        const events = out.events.map(toEventLine);
        const head = out.timedOut
          ? `timed out: ${events.length} of ${count} matched`
          : `matched ${events.length} of ${count}`;
        return {
          text: `${head}\n${eventLinesText(events)}`,
          structured: { matched: events.length, timedOut: out.timedOut, events },
        };
      },
    }),
    tool({
      name: 'check',
      description: `판정: \`filter\`에 맞는 이벤트 수가 \`expect\`를 만족하는지. \`count\`는 '==n' | '>=n' | '<=n'(숫자만 주면 '==n'), 또는 \`none: true\`. 생략하면 '>=1'. 대상은 \`runId\`의 Run, 생략하면 열린 Run, 없으면 링버퍼 전체. 예: \`{ filter: { kind: 'sample.data.echoed' }, expect: { count: '==1' }, label: 'echo once' }\`, \`{ filter: { level: 'error' }, expect: { none: true } }\`. 제품·코어 상태는 바꾸지 않고 락도 필요 없음. 판정마다 testbed.check.evaluated 이벤트가 남고 열린 Run 요약에 모임.`,
      input: checkInput,
      readOnly: true,
      run: async (input, caller) => {
        const out = await control.check(
          {
            filter: input.filter,
            expect: input.expect,
            ...(input.label === undefined ? {} : { label: input.label }),
          },
          caller,
        );
        const expected = expectedText(input.expect);
        const label = input.label === undefined ? '' : ` '${input.label}'`;
        return {
          text: `${out.pass ? 'PASS' : 'FAIL'}${label}: ${out.matched} matched (expected ${expected})\n${eventLinesText(out.sample)}`,
          structured: { ...out },
        };
      },
    }),
    tool({
      name: 'export_run',
      description: `Run 이벤트 전체(JSONL)를 받을 URL을 돌려줌. 본문은 돌려주지 않음. \`runId\`를 생략하면 열린 Run, 없으면 가장 최근에 닫힌 Run. file 저장소면 파일 경로 \`path\`도 줌.${READ_ONLY}`,
      input: exportRunInput,
      readOnly: true,
      run: async ({ runId }, caller) => {
        const out = await control.exportLocation(runId, caller);
        return {
          text: `Run ${out.runId}: ${out.url}${out.path === undefined ? '' : `\nfile: ${out.path}`}`,
          structured: out,
        };
      },
    }),
    tool({
      name: 'acquire_control',
      description:
        '제어 락을 명시적으로 잡음(조작 도구는 첫 호출 때 자동으로 잡음). 잡고 있는 동안 사람은 대시보드에서 조작할 수 없음. 이 세션의 호출마다 만료가 연장됨. 다른 보유자가 있으면 LEASE_HELD.',
      input: emptyInput,
      readOnly: false,
      run: (_input, caller) => {
        const { expiresAt } = control.acquireLease(caller);
        return Promise.resolve({
          text: `lease held until ${expiresAt}; 끝나면 release_control`,
          structured: { expiresAt },
        });
      },
    }),
    tool({
      name: 'release_control',
      description:
        '이 세션이 가진 제어 락을 풂. 작업이 끝나면 반드시 부름. 이 세션이 락을 갖고 있지 않으면(락이 없거나 다른 보유자) 오류 없이 `released: false`.',
      input: emptyInput,
      readOnly: false,
      run: (_input, caller) => {
        const out = control.releaseLease(caller);
        return Promise.resolve({
          text: out.released ? 'lease released' : 'no lease was held',
          structured: out,
        });
      },
    }),
  ];
}

const REPLICA_NOTE =
  ' 외부 코어: `replica`(예: "r1")를 주면 그 복제에만, 없으면 모든 복제에 보내고 복제가 둘 이상이면 { r0: 출력, r1: 출력 }을 돌려줌.';

/** An external core's action tool also takes `replica` (protocol §6). */
function withReplica(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      replica: {
        type: 'string',
        description: 'One replica (r0, r1, …); omit for every replica',
      },
    },
  };
}

/** `<core>_<action>` for every action whose `surfaces` include `mcp`. */
function actionTools(control: ControlService): McpTool[] {
  const manifest = control.getManifest({ actor: 'system' });
  return manifest.cores.flatMap((core) =>
    core.actions
      .filter((action) => action.surfaces.includes('mcp'))
      .map((action): McpTool => ({
        name: `${core.id.replaceAll('-', '_')}_${action.name}`,
        description: `${action.description}${core.external ? REPLICA_NOTE : ''}${action.mutating ? LOCKED : READ_ONLY}`,
        inputSchema: core.external
          ? withReplica(objectSchema(action.inputSchema))
          : objectSchema(action.inputSchema),
        readOnly: !action.mutating,
        call: async (input, caller) => {
          let rest: unknown = input ?? {};
          let replica: string | undefined;
          if (core.external && typeof rest === 'object' && rest !== null && 'replica' in rest) {
            const { replica: picked, ...others } = rest as Record<string, unknown>;
            if (typeof picked === 'string') replica = picked;
            rest = others;
          }
          const output = await control.invokeAction(core.id, action.name, rest, caller, replica);
          return { text: JSON.stringify(output), structured: plain(output) };
        },
      })),
  );
}

/**
 * The tools of the moment. The common ones never change; action tools are
 * read from the manifest on every call, because an external core's actions
 * are known only once its process has initialized (and can change on restart).
 */
export function createTools(control: ControlService): () => Map<string, McpTool> {
  const common = commonTools(control);
  return () => new Map([...common, ...actionTools(control)].map((entry) => [entry.name, entry]));
}

/**
 * Expected failures become a tool result with `isError` and a sentence that
 * says what to do next; anything else is rethrown (JSON-RPC internal error).
 */
const NOT_FOUND_NEXT: Record<string, string> = {
  event: 'query_events로 있는 이벤트 id를 확인',
  run: 'testbed_info(열린 Run)나 REST GET /testbed/api/runs로 있는 Run id를 확인',
};

export function errorResult(
  error: unknown,
  /** The ids that do exist, for a NOT_FOUND message (`ControlService.knownIds`). */
  knownIds?: (resource: string, id: string) => string[] | undefined,
): ToolResult {
  let code: string;
  let message: string;
  let details: unknown;
  if (error instanceof TestbedError) {
    ({ code, message, details } = error);
  } else if (error instanceof ValidationError) {
    code = 'VALIDATION_ERROR';
    message = `입력이 올바르지 않음(${error.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}). 도구의 입력 스키마에 맞춰 다시 호출`;
    details = error.issues;
  } else if (error instanceof NotFoundError) {
    code = 'NOT_FOUND';
    const known = knownIds?.(error.resource, error.id);
    const next =
      known === undefined
        ? (NOT_FOUND_NEXT[error.resource] ?? 'testbed_info로 있는 id를 확인')
        : `있는 ${error.resource}: ${known.length === 0 ? '(없음)' : known.join(', ')}`;
    message = `${error.resource} '${error.id}' 없음. ${next}`;
    details = {
      resource: error.resource,
      id: error.id,
      ...(known === undefined ? {} : { known }),
    };
  } else {
    throw error;
  }
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message, ...(details === undefined ? {} : { details }) } },
    isError: true,
  };
}
