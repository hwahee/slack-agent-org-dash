# 코어 계약

코어는 테스트베드의 실제 기능입니다. 기본은 Bun 프로세스 안에서 도는 **in-proc 코어**이고, 그 밖의 경우는 [external-core-protocol.md](external-core-protocol.md)를 따릅니다.

## 1. 정의

아래는 개념 정의입니다. 정확한 이름과 파일 위치는 `testbed-base` 구현(P1)에서 확정하고, 확정되면 이 문서를 고칩니다.

```ts
// src/shared/testbed/core.ts
interface CoreDefinition<C> {
  id: string; // 'echo', 'llm' — 이벤트 kind 접두사, env 접두사, MCP 도구 접두사로 쓰임
  kind: 'passive' | 'active' | 'scenario';
  title: string;
  configSchema: Validator<C>; // @shared/validation 파사드. 매니페스트에는 JSON Schema로 노출
  defaultConfig: (env: Env) => C; // env는 기본값만 줌. 런타임 변경은 제어 API로
  actions?: Record<string, ActionDefinition>; // 고유 동작 (§4)
  faults?: FaultCapability; // 지원하는 결함 종류 (faults-and-seed.md)
  create(ctx: CoreContext<C>): CoreInstance<C>;
}

interface CoreContext<C> {
  emit(e: CoreEventInput): void; // 봉투의 공통 필드(seq, id, ts, runId, core, actor 기본값)는 런타임이 채움
  log: Logger;
  rng: SeededRng; // 모든 무작위는 이것으로
  run(): RunHandle | null; // 열린 Run, 없으면 null
  faults: FaultDecider; // 결함 판정 도우미
  signal: AbortSignal; // stop/shutdown 때 abort
}

interface CoreInstance<C> {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset?(): Promise<void>; // 내부 상태·카운터 초기화. 포트는 유지
  applyConfig(next: C): Promise<'applied' | 'restart-required'>;
  status(): CoreStatus; // state, endpoints, counters, 코어별 요약
}
```

## 2. 규칙

- **id**: 소문자, 숫자, `-`만 씁니다(`^[a-z][a-z0-9-]*$`). MCP 도구 이름에서는 `-`를 `_`로 바꿉니다. `testbed`는 공통 런타임 자신의 자리라 쓰지 않습니다.
- **코드 위치**: 코어 코드는 `src/server/testbed/cores/<id>/`, 이벤트 payload 스키마는 `src/shared/testbed/cores/<id>/events.ts`, 고유 화면은 `src/client/testbed/cores/<id>/`에 둡니다.
- **무작위**: `Math.random()`을 쓰지 않습니다. `ctx.rng`만 씁니다(ESLint가 `src/server/testbed/cores/**`에서 막음).
- **관찰 가능한 일은 모두 이벤트로** 남기고 `summary`를 반드시 채웁니다([events.md](events.md)).
- **비밀값**은 이벤트에 담기 전에 공통 가림 유틸을 거칩니다.
- **env**는 `defaultConfig`에서만 읽습니다. 코어 안에서 `process.env`를 직접 읽지 않습니다.

## 3. 상태 기계

```
idle → starting → running → stopping → stopped
  └──────────── 어느 상태에서든 → error
```

- 상태가 바뀔 때마다 `testbed.core.state` 이벤트가 나갑니다(`actor: 'system'`).
- `error`에서는 `start`로 다시 시작할 수 있습니다. `error`로 갈 때 이벤트의 `level`은 `error`이고, `payload.detail`에 원인을 담습니다.
- `status().endpoints`는 데이터면 주소 목록(`{ name, protocol, url }`)입니다. 매니페스트, 대시보드 연결 패널, MCP `testbed_info`에 그대로 나타납니다. `url`은 `TESTBED_PUBLIC_URL`의 호스트를 씁니다.
- 부팅 시 자동 시작 여부는 코어 설정 `autoStart`로 정합니다. passive는 기본 `true`, active·scenario는 기본 `false`입니다.
- `applyConfig`가 `restart-required`를 돌려주면 설정은 저장되지만 적용되지 않습니다. 제어 서비스가 `RESTART_REQUIRED`로 알리고, 다음 `stop` → `start` 때 적용됩니다.

## 4. 액션

공통 동작(start, stop, config 등)으로 표현되지 않는 기능은 액션으로 등록합니다.

```ts
interface ActionDefinition {
  title: string;
  description: string; // 에이전트가 읽는 설명 — 부작용, 단위, 상한, 락 필요 여부를 적음
  input: Validator<unknown>;
  output: Validator<unknown>;
  mutating: boolean; // true면 제어 락이 필요함
  surfaces?: ('rest' | 'mcp' | 'ui')[]; // 기본: 셋 다
}
```

- 액션 하나를 등록하면 세 곳에 **자동 노출**됩니다. REST·MCP·UI에 따로 구현하지 않습니다.
  - REST: `POST /testbed/api/cores/:core/actions/:name`
  - MCP 도구: `<core>_<name>`
  - 대시보드 코어 카드: 액션 버튼과 입력 폼
- `surfaces`로 한쪽을 빼면 스펙의 "제어 표면" 표에 이유를 적습니다.
- 액션 이름은 `snake_case`입니다. 예: LLM 대역 `enqueue_response`, 부하 발생기 `fire_once`, 시나리오 `run_scenario`.
- 외부 코어는 같은 정의를 `initialize` 응답으로 알립니다([external-core-protocol.md](external-core-protocol.md)).
