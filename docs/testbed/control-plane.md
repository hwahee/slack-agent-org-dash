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

## 4. MCP — `/testbed/mcp`

- **전송**: Streamable HTTP. 공식 TypeScript SDK를 기본으로 씁니다. Bun 호환성은 P1 첫 작업에서 확인합니다.
- **세션**: `Mcp-Session-Id`가 락 보유자의 식별자입니다.
- **initialize의 `instructions`**: "처음엔 `testbed_info` → `start_run` → 제품 작업 → `query_events`/`check` → `end_run`".

### 4.1 공통 도구

| 도구                                  | 하는 일                                                                                                | 락     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| `testbed_info`                        | 매니페스트 요약, 코어 상태, 데이터면 주소, 열린 Run, 락 보유자                                         | –      |
| `get_config` / `set_config`           | 코어 설정 조회 / 부분 변경                                                                             | set만  |
| `start` / `stop` / `reset`            | 코어 지정 또는 전체                                                                                    | ●      |
| `start_run` / `end_run`               | Run 시작 / 종료 + 요약. `endActive: true`로 열린 Run을 닫고 시작                                       | ●      |
| `query_events`                        | 필터(§1.2) → **summary 줄 목록 + 다음 커서**                                                           | –      |
| `get_event`                           | 이벤트 하나의 전체 payload                                                                             | –      |
| `wait_for`                            | 필터에 맞는 이벤트가 n건 올 때까지 대기. 기본 30초, 상한 120초. 시간이 지나면 지금까지의 결과를 돌려줌 | –      |
| `check`                               | 판정([runs-and-checks.md](runs-and-checks.md))                                                         | –      |
| `export_run`                          | 내보내기 파일의 URL·경로를 돌려줌(본문을 쏟아내지 않음)                                                | –      |
| `acquire_control` / `release_control` | 제어 락                                                                                                | –      |
| `<core>_<action>`                     | 코어 액션(자동 노출)                                                                                   | 액션별 |

### 4.2 도구 설계 규칙

스펙과 공통 런타임 모두에 적용합니다.

1. 결과는 `content`(사람이 읽는 짧은 텍스트)와 `structuredContent`(기계용)를 함께 줍니다.
2. **토큰 절약이 기본**입니다. `query_events`는 기본 50건이고 payload 없이 summary만 줍니다. 전체 내용은 `get_event`로 따로 봅니다.
3. 설명문에는 부작용, 단위(ms, bytes), 상한, 락 필요 여부를 적습니다. 에이전트가 설명만 보고 올바르게 호출할 수 있어야 합니다.
4. 오류는 다음 행동을 알려 주는 문장으로 씁니다. 예: "Run이 이미 열려 있음(run-7-k3f9, 'gw-retry'). `end_run` 후 다시 시도하거나 `start_run`에 `endActive: true`".

## 5. WS — `/testbed/ws`

- 대시보드 전용입니다. 연결하면 `snapshot`(상태 + 최근 이벤트)을 받고, 이후 `event`, `status`, `lease` 증분을 받습니다.
- 조작은 WS로 보내지 않습니다. 대시보드의 조작은 REST로 합니다.

## 6. 매니페스트 — `GET /testbed/api/manifest`

```jsonc
{
  "name": "testbed-llm-mock",
  "version": "<git sha>",
  "instanceId": "…",
  "baseVersion": "<testbed-base 버전>",
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
