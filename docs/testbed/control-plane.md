# 제어면

테스트베드를 조작·관찰하는 통로입니다. REST, MCP, WS는 모두 **제어 서비스** 함수를 부르는 얇은 어댑터입니다. 같은 동작을 두 번 구현하지 않습니다.

## 1. 제어 서비스

### 1.1 함수

| 함수                            | 조작성(락 필요) | 내용                                            |
| ------------------------------- | --------------- | ----------------------------------------------- |
| `getManifest`                   | –               | 매니페스트(§6)                                  |
| `getStatus`                     | –               | 코어 상태, 열린 Run, 락                         |
| `getConfig` / `setConfig`       | set만           | 코어 설정 조회 / 부분 패치                      |
| `start` / `stop` / `reset`      | ●               | 코어 하나 또는 전체                             |
| `startRun` / `endRun`           | ●               | [runs-and-checks.md](runs-and-checks.md)        |
| `listRuns`                      | –               | Run 목록과 요약                                 |
| `queryEvents` / `getEvent`      | –               | 이벤트 조회 / 하나의 전체 payload               |
| `waitFor`                       | –               | 조건에 맞는 이벤트 대기                         |
| `check`                         | –               | 판정                                            |
| `exportRun`                     | –               | JSONL 내보내기                                  |
| `exportLocation`                | –               | 내보내기 URL·파일 경로(MCP `export_run`)        |
| `invokeAction`                  | 액션별          | 코어 액션([core-contract.md](core-contract.md)) |
| `acquireLease` / `releaseLease` | –               | 제어 락                                         |

- 모든 함수는 `caller: { actor, sessionId?, leaseId?, name? }`를 받습니다. `sessionId`는 MCP 세션 id, `leaseId`는 REST로 잡은 락의 id, `name`은 표시 이름(예: MCP `clientInfo.name`)입니다.
- 조작성 함수가 불리면 `testbed.control.invoked` 이벤트가 남습니다(함수 이름, 입력 요약, caller, 결과).

### 1.2 이벤트 필터

`queryEvents`, `waitFor`, `check`가 같은 필터를 씁니다.

| 필드            | 뜻                                                         |
| --------------- | ---------------------------------------------------------- |
| `runId`         | Run 지정. `'current'`는 열린 Run                           |
| `core`          | 코어 id                                                    |
| `kind`          | kind 접두사. `llm.completion`이면 그 아래 전부             |
| `level`         | 이 수준 이상                                               |
| `actor`         | 행위 주체                                                  |
| `correlationId` | 같은 묶음                                                  |
| `text`          | summary 부분 일치                                          |
| `after`         | 커서 `<instanceId>:<seq>` 다음부터([events.md](events.md)) |
| `limit`         | 기본 50, 상한 500                                          |

## 2. 제어 락

> **확정**: 에이전트가 제어하는 동안 사람은 대시보드에서 조작할 수 없습니다. 보기는 계속 가능합니다. 대시보드에 강제 해제 버튼은 두지 않습니다. 비상 해제 수단은 TTL 만료와 서버 쪽 `bun run testbed:release` 명령입니다.

### 2.1 MCP (에이전트)

- **획득**: 에이전트의 첫 조작성 호출 때 자동으로 획득합니다. `acquire_control`로 명시적으로 얻을 수도 있습니다. 보유자는 MCP 세션 id(`Mcp-Session-Id`)와 `clientInfo.name`입니다.
- **유지**: 보유자가 제어면을 호출할 때마다 TTL(`TESTBED_LEASE_TTL_SEC`, 기본 600초)이 연장됩니다. 읽기 호출도 연장합니다. 호출 없이 TTL이 지나면 자동 해제되고 `testbed.lease.expired` 이벤트가 남습니다.
- **해제**: `release_control`, MCP 세션 종료(`DELETE`), TTL 만료 중 하나.

### 2.2 REST (CI)

- `POST /lease`는 `{ leaseId, expiresAt }`를 돌려줍니다. 이후 조작성 REST 호출에는 `X-Testbed-Lease: <leaseId>` 헤더를 붙입니다. 헤더가 붙은 호출마다 TTL이 연장됩니다.
- REST에는 "첫 조작 때 자동 획득"이 없습니다. CI는 조작 전에 `POST /lease`, 끝나면 `DELETE /lease`(같은 헤더)를 부릅니다.
- 같은 CI 토큰을 쓰는 작업 두 개도 `leaseId`로 구분됩니다.

### 2.3 잠겨 있는 동안

| 호출하는 쪽      | 조작성 호출의 결과      |
| ---------------- | ----------------------- |
| 보유자           | 정상                    |
| 다른 에이전트·CI | `LEASE_HELD` (HTTP 409) |
| 사람(대시보드)   | `LOCKED` (HTTP 423)     |

- 오류에는 보유자(actor, 이름, 세션 id 앞 4자)와 남은 시간이 담깁니다.
- 읽기(상태, 이벤트, 내보내기)는 모두에게 열려 있습니다.
- 거절될 때마다 `testbed.lease.denied` 이벤트가 남습니다.
- 사람은 락을 잡지 않습니다. 락이 없을 때 사람은 자유롭게 조작하고, 에이전트가 조작을 시작하면 그때부터 잠깁니다.
- 락은 유예 없이 즉시 걸립니다. 사람이 편집하던 입력의 처리는 [dashboard.md](dashboard.md)를 따릅니다.
- 이벤트와 Run 메타에는 caller의 세션 id·lease id를 **앞 4자만** 남깁니다. 이벤트와 Run은 누구나 읽으므로, 전체 id를 남기면 그것으로 보유자 행세를 할 수 있기 때문입니다.

### 2.4 강제 해제 — `bun run testbed:release`

- 실행 중인 인스턴스의 로컬 전용 경로 `POST /testbed/internal/release`를 `127.0.0.1:$PORT`로 부릅니다. 루프백이 아닌 주소에서 오거나 `X-Forwarded-For`가 붙은 요청은 404로 거절합니다.
- 해제는 `testbed.lease.released`(`actor: 'system'`, `payload.reason: 'forced'`)로 남습니다. 다른 해제 사유는 `released`(보유자가 해제), `session-closed`(MCP 세션 종료)입니다.

## 3. REST — `/testbed/api`

| 메서드·경로                            | 내용                                                |
| -------------------------------------- | --------------------------------------------------- |
| `GET /manifest`                        | §6                                                  |
| `GET /status`                          | 코어 상태, 열린 Run, 락                             |
| `GET /cores/:core/config`              | 설정 조회                                           |
| `PATCH /cores/:core/config`            | 부분 패치. 응답에 `applied` 또는 `restart-required` |
| `POST /cores/:core/{start,stop,reset}` | `:core`를 `_all`로 쓰면 전체                        |
| `POST /cores/:core/actions/:name`      | 코어 액션                                           |
| `POST /runs`                           | Run 시작                                            |
| `POST /runs/current/end`               | Run 종료                                            |
| `GET /runs` · `GET /runs/:id`          | 목록과 요약                                         |
| `GET /runs/:id/export`                 | JSONL 스트림                                        |
| `GET /events?…filter&after&limit`      | 조회(§1.2)                                          |
| `GET /events/:id`                      | 전체 payload. `:id`는 이벤트 id                     |
| `POST /wait` · `POST /check`           | §4와 같음                                           |
| `POST /lease` · `DELETE /lease`        | 락 획득·해제(§2.2)                                  |

- 오류는 보일러플레이트의 에러 엔벨로프(`src/shared/api/errors.ts`)를 따릅니다. 추가 코드:

  | 코드               | HTTP | 뜻                                                                                                                                                            |
  | ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `LOCKED`           | 423  | 에이전트·CI가 제어 중이라 사람의 조작 거절                                                                                                                    |
  | `LEASE_HELD`       | 409  | 다른 보유자가 락을 가짐                                                                                                                                       |
  | `RUN_ACTIVE`       | 409  | 이미 열린 Run이 있음                                                                                                                                          |
  | `CORE_NOT_RUNNING` | 409  | 코어가 `running`이 아님                                                                                                                                       |
  | `RESTART_REQUIRED` | 409  | `start_run`의 `configOverrides`처럼 즉시 적용돼야 하는 설정이 재시작을 요구함. `PATCH /config`는 오류가 아니라 200 응답의 `result: 'restart-required'`로 알림 |
  | `CURSOR_STALE`     | 410  | 다른 인스턴스의 커서                                                                                                                                          |

- 응답 모양
  - `GET /status` → `{ instanceId, cores: CoreStatus[], run: RunMeta | null, lease: LeaseView | null }`
  - `PATCH /cores/:core/config` → `{ result: 'applied' | 'restart-required', config }`
  - `POST /cores/:core/{start,stop,reset}` → `{ cores: CoreStatus[] }`
  - `POST /runs` → 201 `RunMeta`. `GET /runs` → `{ runs }`. `GET /runs/current`는 열린 Run입니다.
  - `POST /runs/current/end` → 닫힌 `RunMeta`(요약 포함). 열린 Run이 없으면 404 `NOT_FOUND`
  - `GET /events` → `{ events, cursor, total }`. `cursor`는 마지막으로 돌려준 이벤트의 id(없으면 `after` 그대로), `total`은 커서 뒤에서 필터에 맞는 이벤트 수(`limit`을 넘는 것 포함)입니다. 닫힌 Run을 `runId`로 지정하면 Run 저장소에서 읽습니다.
  - `POST /wait` `{ filter, count?, timeoutMs? }` → `{ events, timedOut }`. `after`가 없으면 부른 뒤부터 셉니다. 이 경로는 `Bun.serve`의 유휴 타임아웃을 끄고 받습니다(최대 120초 대기).
  - `POST /lease` → `{ leaseId, expiresAt }`. `DELETE /lease` → `{ released }`
- 오류 코드의 HTTP 상태는 `src/shared/testbed/errors.ts`의 `TESTBED_ERROR_STATUS`가 원본입니다. 없는 경로는 JSON 404입니다.
- `start_run`의 `configOverrides`는 Run이 닫힐 때(교체 포함) Run 직전 설정으로 돌아갑니다. 하나라도 재시작이 필요하면 모두 되돌리고 `RESTART_REQUIRED`입니다.

## 4. MCP — `/testbed/mcp`

- **전송**: Streamable HTTP. 공식 TypeScript SDK(`@modelcontextprotocol/sdk`)의 `WebStandardStreamableHTTPServerTransport`를 `Bun.serve` 라우트에 바로 붙입니다(웹 표준 `Request`/`Response`, Node `http` 흉내 없음). 응답은 기본 SSE 방식입니다. 확인 결과는 `testbed-base`의 `docs/spec.md` 2절. 구현은 `src/server/testbed/mcp/`(`endpoint.ts` 세션·인증, `tools.ts` 도구, `format.ts` 문장).
- **세션**: MCP 세션마다 전송과 서버를 하나씩 만들고 `Mcp-Session-Id`로 고릅니다. 세션 없는 요청은 `initialize`만 받고(그 밖은 400), 끝난 세션의 요청은 404입니다.
  - caller는 `{ actor: 'agent', sessionId: <Mcp-Session-Id>, name: <clientInfo.name> }`이고, `Mcp-Session-Id`가 락 보유자의 식별자입니다.
  - 세션이 끝나는 경우: `DELETE`, 유휴 정리, 서버 종료. 어느 경우든 그 세션이 쥔 락도 풀립니다(`testbed.lease.released`, `reason: 'session-closed'`).
  - 상한 `TESTBED_MCP_MAX_SESSIONS`(기본 32): 넘으면 새 `initialize`를 HTTP 503과 JSON-RPC 오류로 거절합니다. 문장: "MCP 세션이 상한(32)에 도달함. 쓰지 않는 세션을 닫거나(`DELETE`) 잠시 뒤 다시 시도".
  - 유휴 정리 `TESTBED_MCP_SESSION_IDLE_SEC`(기본 3600): 그 시간 동안 요청이 없는 세션은 서버가 닫습니다. 실행 중인 도구 호출이 있는 동안에는 닫지 않습니다.
  - MCP 요청은 `Bun.serve`의 유휴 타임아웃(10초)을 끄고 받습니다. `wait_for`가 최대 120초 동안 응답하지 않을 수 있기 때문입니다(REST `POST /wait`도 같음).
- **인증**: `TESTBED_CONTROL_TOKEN`이 있으면 모든 MCP 요청에 `Authorization: Bearer <token>`이 필요합니다. 없거나 틀리면 401(JSON-RPC 오류, `WWW-Authenticate: Bearer`)입니다. 토큰이 없으면(로컬) 인증 없이 받습니다. MCP 호출자는 언제나 `agent`이고, `X-Testbed-Actor`는 보지 않습니다.
- **initialize의 `instructions`** (그대로 씀):
  > 테스트베드 제어면입니다. 처음엔 `testbed_info`로 코어·데이터면 주소·락 상태를 봅니다. 시험은 `start_run` → 제품 작업 → `query_events`/`wait_for`/`check` → `end_run` 순서로 합니다. 조작 도구는 첫 호출 때 제어 락을 잡고, 그동안 사람은 대시보드에서 조작할 수 없습니다. 끝나면 `release_control`을 부릅니다.

### 4.1 공통 도구

모든 도구는 제어 서비스 함수(§1)를 부르기만 합니다. 입력 검증기는 REST와 같은 것(`src/server/testbed/control/inputs.ts`)을 쓰고, 그 JSON Schema가 도구의 `inputSchema`입니다.

| 도구                       | 입력                                                                                                   | `structuredContent`                                                                                          | 락     |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| `testbed_info`             | `{}`                                                                                                   | `{ name, version, instanceId, cores:[{id, kind, state, endpoints, actions:[name]}], run, lease }`            | –      |
| `get_config`               | `{ core }`                                                                                             | 설정 객체                                                                                                    | –      |
| `set_config`               | `{ core, patch }`                                                                                      | `{ result: 'applied' \| 'restart-required', config }`                                                        | ●      |
| `start` / `stop` / `reset` | `{ core?: string }` (생략하면 `_all`)                                                                  | `{ cores: CoreStatus[] }`                                                                                    | ●      |
| `start_run`                | `{ label, seed?, configOverrides?, endActive? }`                                                       | `RunMeta`                                                                                                    | ●      |
| `end_run`                  | `{}`                                                                                                   | `RunMeta`(요약 포함)                                                                                         | ●      |
| `query_events`             | 이벤트 필터 전체(`runId`, `core`, `kind`, `level`, `actor`, `correlationId`, `text`, `after`, `limit`) | `{ events: EventLine[], nextCursor, total }` — payload 없음                                                  | –      |
| `get_event`                | `{ id }`                                                                                               | 이벤트 전체                                                                                                  | –      |
| `wait_for`                 | `{ filter, count?: 1, timeoutMs?: 30000 }` (상한 120000)                                               | `{ matched, timedOut, events: EventLine[] }`                                                                 | –      |
| `check`                    | `{ filter, expect, label? }`                                                                           | `{ pass, matched, sample: EventLine[] }`                                                                     | –      |
| `export_run`               | `{ runId?: string }` (생략하면 열린 Run, 없으면 가장 최근에 닫힌 Run)                                  | `{ runId, url, path? }` — `url`은 `TESTBED_PUBLIC_URL` 기준 export 주소, `path`는 file 저장소일 때 파일 경로 | –      |
| `acquire_control`          | `{}`                                                                                                   | `{ expiresAt }`                                                                                              | –      |
| `release_control`          | `{}`                                                                                                   | `{ released }`                                                                                               | –      |
| `<core>_<action>`          | 액션의 `input`                                                                                         | 액션의 출력(객체가 아니면 `{ result }`)                                                                      | 액션별 |

- `EventLine`은 `{ id, ts, level, kind, summary, correlationId? }`입니다(`src/shared/testbed/events.ts`의 `toEventLine`).
- `query_events`의 `total`은 커서 뒤에서 필터에 맞는 이벤트 수(`limit`을 넘는 것 포함)이고, `nextCursor`는 마지막으로 돌려준 이벤트의 id(없으면 `after` 그대로)입니다.
- `wait_for`의 `timeoutMs`가 상한을 넘으면 검증 오류가 아니라 120000으로 잘립니다.
- **액션 자동 노출**: `surfaces`에 `mcp`가 있는 액션마다 `<core>_<action>` 도구를 만듭니다. 코어 id의 `-`는 `_`로 바꿉니다. 설명은 액션의 `description`에 " (제어 락 필요)" 또는 " (읽기 전용)"을 덧붙이고, 입력 스키마는 액션 `input` 검증기의 JSON Schema입니다.
- **도구 주석**: 읽기 도구(`testbed_info`, `get_config`, `query_events`, `get_event`, `wait_for`, `check`, `export_run`, `mutating: false` 액션)는 `annotations.readOnlyHint: true`, 나머지는 `false`입니다.
- **결과 형식**
  - 성공: `content`에 사람이 읽는 짧은 텍스트(여러 줄 가능), `structuredContent`에 기계용 객체.
  - 실패: 제어 서비스가 던진 `TestbedError`, 검증 오류(`VALIDATION_ERROR`), 없는 대상(`NOT_FOUND`)은 JSON-RPC 오류가 아니라 도구 결과 `isError: true`입니다. `content`에는 오류 문장(다음 행동을 알려 주는 문장)을, `structuredContent`에는 `{ error: { code, message, details } }`를 담습니다. 예상하지 못한 예외만 JSON-RPC 내부 오류입니다. 없는 도구 이름은 JSON-RPC `InvalidParams`입니다.
  - 입력 검증은 SDK가 아니라 제어 서비스 쪽 검증기가 하므로 실패도 같은 형식(`VALIDATION_ERROR`)입니다. 그래서 SDK의 저수준 `Server`에 `tools/list`·`tools/call` 처리기를 직접 답니다.
- **이벤트 한 줄 형식**(`query_events`, `wait_for`, `check`의 `content`): `<id> <HH:MM:SS.mmm> <level> <kind> <summary>`. 시각은 UTC입니다.
- `testbed_info`의 `content`는 이름·버전·instanceId 한 줄, 코어마다 한 줄(`sample running tcp://127.0.0.1:40001 actions: broadcast`), 열린 Run 한 줄, 락 보유자 한 줄입니다.

### 4.2 도구 설계 규칙

스펙과 공통 런타임 모두에 적용합니다.

1. 결과는 `content`(사람이 읽는 짧은 텍스트)와 `structuredContent`(기계용)를 함께 줍니다.
2. **토큰 절약이 기본**입니다. `query_events`는 기본 50건이고 payload 없이 summary만 줍니다. 전체 내용은 `get_event`로 따로 봅니다.
3. 설명문에는 부작용, 단위(ms, bytes), 상한, 락 필요 여부를 적습니다. 에이전트가 설명만 보고 올바르게 호출할 수 있어야 합니다.
4. 오류는 다음 행동을 알려 주는 문장으로 씁니다. 예: "Run이 이미 열려 있음(run-7-k3f9, 'gw-retry'). `end_run` 후 다시 시도하거나 `start_run`에 `endActive: true`".

## 5. WS — `/testbed/ws`

- 대시보드 전용입니다. 연결하면 `snapshot`(상태 + 최근 이벤트)을 받고, 이후 `event`, `status`, `lease` 증분을 받습니다.
- 조작은 WS로 보내지 않습니다. 대시보드의 조작은 REST로 합니다.
- 메시지(`TestbedSocketMessage`, `src/server/testbed/http/ws.ts`)
  - `{ type: 'snapshot', status, events }` — 연결 직후 한 번. `events`는 링버퍼의 최근 200건
  - `{ type: 'event', events, omitted }` — 100ms마다 묶어 보냄
  - `{ type: 'status', status }` — 코어 상태 변화, Run 시작·종료 때
  - `{ type: 'lease', lease }` — 락 획득·해제·만료 때
- 표본화: 1초 안에 200건을 넘으면 그 뒤로는 10건 중 1건만 보내고, 나머지 건수를 `omitted`에 담습니다. 링버퍼와 Run 저장소에는 모두 남습니다.
- `AUTH_DRIVER=oidc`면 로그인한 사람만 연결할 수 있습니다.

## 6. 매니페스트 — `GET /testbed/api/manifest`

```jsonc
{
  "name": "testbed-llm-mock",
  "version": "<git sha>",
  "instanceId": "…",
  "baseVersion": "<testbed-base 버전>",
  "publicUrl": "http://host:40020",
  "cores": [
    {
      "id": "llm",
      "kind": "passive",
      "title": "…",
      "state": "running",
      "replicas": 1,
      "endpoints": [{ "name": "openai", "protocol": "http", "url": "http://host:40021/v1" }],
      "actions": [{ "name": "enqueue_response", "mutating": true, "inputSchema": {} }],
      "configSchema": {},
      "faults": ["delay", "error", "disconnect"],
    },
  ],
  "control": { "rest": "/testbed/api", "mcp": "/testbed/mcp", "ws": "/testbed/ws" },
  "auth": { "control": "none | bearer" },
  "features": { "runStore": "file", "seed": true },
}
```

- `version`은 빌드의 git SHA, `baseVersion`은 이 테스트베드가 머지한 `testbed-base`의 공통 런타임 버전(`src/server/testbed/version.ts`)입니다.
- `publicUrl`은 `TESTBED_PUBLIC_URL`입니다. 대시보드 연결 패널의 MCP URL과 `.mcp.json` 조각은 모두 이 값으로 만듭니다.
- 타입은 `src/shared/testbed/control.ts`의 `TestbedManifest`입니다(`TestbedStatus`, WS 메시지 `TestbedSocketMessage`도 같은 곳).
- `configSchema`와 액션의 `inputSchema`는 검증기에서 만든 JSON Schema입니다(`toJsonSchema`, `@shared/validation`).

## 7. 인증

| 대상                          | 로컬               | 공용 서버·클라우드                                                            |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| 대시보드(사람)                | 없음               | `AUTH_DRIVER=oidc`(보일러플레이트의 회원 로그인). 브라우저에 토큰을 두지 않음 |
| 제어면 MCP/REST (에이전트·CI) | 없음               | `TESTBED_CONTROL_TOKEN` Bearer                                                |
| 데이터면                      | 코어별 (대개 없음) | 코어별. 제품의 인증 처리를 시험하는 것이 목적이면 그 코어의 스펙에서 정함     |

- actor 판별
  - 대시보드 세션에서 온 요청: `human`
  - MCP: `agent`
  - CI 토큰으로 온 REST: `ci`
  - 로컬에서 인증이 없을 때는 자기 신고(`X-Testbed-Actor`)입니다. 헤더가 없으면 `human`으로 봅니다. 개발 도구이므로 허용합니다.
- `TESTBED_CONTROL_TOKEN`을 설정하면 `Authorization: Bearer <token>`이 맞는 호출만 에이전트·CI로 받고(`X-Testbed-Actor`가 `agent`면 agent, 아니면 ci), Bearer 없이 `agent`·`ci`를 자처하면 401 `UNAUTHORIZED`입니다. Bearer 없는 호출은 `human`이며, `AUTH_DRIVER=oidc`면 로그인한 사람이어야 합니다.
- REST의 lease id는 `X-Testbed-Lease` 헤더로 보냅니다.

## 8. 코드 위치

| 무엇                               | 위치                                       |
| ---------------------------------- | ------------------------------------------ |
| 제어 서비스                        | `src/server/testbed/control/service.ts`    |
| 제어 락(REST lease, MCP 세션 함수) | `src/server/testbed/control/lease.ts`      |
| caller 판별·토큰                   | `src/server/testbed/http/auth.ts`          |
| REST 어댑터                        | `src/server/testbed/http/rest.ts`          |
| WS 어댑터                          | `src/server/testbed/http/ws.ts`            |
| 강제 해제 경로·라우트 묶음         | `src/server/testbed/http/routes.ts`        |
| 조립(부팅)                         | `src/server/testbed/runtime.ts`            |
| `bun run testbed:release`          | `scripts/testbed-release.ts`               |
| 오류 코드·HTTP 상태, `LeaseView`   | `src/shared/testbed/errors.ts`, `lease.ts` |

- P2의 MCP 어댑터는 `LeaseManager.authorize`에 `sessionId`가 든 caller를 넘겨 첫 조작 때 자동 획득·호출마다 연장을 받고, 세션이 끝나면 `releaseSession(sessionId)`을 부릅니다.
