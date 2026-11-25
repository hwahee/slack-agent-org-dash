# 외부 프로세스 코어 프로토콜

Bun 밖에서 도는 코어(Python, Java 등)와 glue가 주고받는 규약입니다. 로컬 자식 프로세스(stdio)는 `testbed-base` P4, 원격 워커 전송(WS)은 P5입니다.

## 1. 언제 쓰나

다음 경우에만 씁니다. 그 외에는 in-proc 코어([core-contract.md](core-contract.md))를 씁니다.

- 다른 언어 SDK가 필요함(예: Java 전용 클라이언트 라이브러리)
- Python 전용 모듈이 필요함
- 대량 연산
- Bun으로 낼 수 없는 성능

외부 코어를 쓰면 스펙의 "구성" 절에 위 이유 중 무엇인지 적습니다.

## 2. 선언 (glue 쪽)

외부 코어는 `defineExternalCore`로 선언하고, in-proc 코어와 같이 `src/server/testbed/cores/index.ts`의 목록에 넣습니다.

```ts
defineExternalCore({
  id: 'py-echo', // in-proc 코어와 같은 규칙
  kind: 'passive', // initialize 응답과 다르면 그 코어는 error
  title: 'Python TCP echo',
  command: ['python3', '-u', 'examples/python-core/echo_core.py'], // 저장소 루트 기준
  env: { NAME: 'value' }, // (선택) 프로세스에 더 넘길 고정 값
});
```

- 설정 스키마, 기본 설정, 액션, 결함 종류는 선언하지 않습니다. 프로세스가 `initialize` 응답으로 알립니다(§4.1).
- **프로세스에 넘기는 환경 변수**: `PATH`, `HOME`, `LANG`, `TZ`, 코어 접두사 변수(`<CORE_ID>_*` — id를 대문자로, `-`를 `_`로. 예: `PY_ECHO_PORT`), 선언의 `env`만 넘깁니다. `TESTBED_CONTROL_TOKEN` 같은 제어면 비밀값은 넘기지 않습니다.

### 2.1 glue가 붙이는 설정 필드

외부 코어의 설정에는 코어가 정한 필드 외에 glue가 읽는 필드가 붙습니다. 코어의 설정 스키마가 같은 이름을 쓰면 `initialize`를 거절합니다.

| 이름               | 타입                        | 기본         | 범위        | env                      | 재시작 필요 |
| ------------------ | --------------------------- | ------------ | ----------- | ------------------------ | ----------- |
| `replicas`         | int                         | `1`          | 1–16        | `<CORE_ID>_REPLICAS`     | 예          |
| `restart`          | `'never'` \| `'on-failure'` | `on-failure` | –           | `<CORE_ID>_RESTART`      | 아니오      |
| `maxRestarts`      | int                         | `5`          | 0–100       | `<CORE_ID>_MAX_RESTARTS` | 아니오      |
| `pingIntervalMs`   | int                         | `5000`       | 1000–60000  | –                        | 아니오      |
| `pingTimeoutMs`    | int                         | `3000`       | 100–30000   | –                        | 아니오      |
| `requestTimeoutMs` | int                         | `30000`      | 1000–300000 | –                        | 아니오      |
| `shutdownGraceMs`  | int                         | `5000`       | 0–60000     | –                        | 아니오      |

`autoStart`, `eventLevel`, `faults`는 in-proc 코어와 같은 공통 필드이고, 코어의 스키마에 들어 있어야 합니다(참조 어댑터가 넣어 줌).

## 3. 메시지 형식

- JSON-RPC 2.0. 프레이밍은 줄 단위(NDJSON)이며, 메시지 하나가 한 줄입니다(UTF-8, 줄 안에 개행 없음). 한 줄은 최대 1 MiB입니다.
- 요청은 glue → 코어 방향뿐입니다. 코어 → glue는 알림(`id` 없음)만 보냅니다.
- `protocolVersion`은 `"1"`입니다.

## 4. glue → 코어 (요청)

| 메서드        | params                                                                                | result                                                                           |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `initialize`  | `{ protocolVersion, coreId, replicaId, replicaIndex, replicas, seed, runId \| null }` | `{ protocolVersion, kind, title, configSchema, defaultConfig, actions, faults }` |
| `applyConfig` | `{ config }`                                                                          | `{ result: 'applied' \| 'restart-required' }`                                    |
| `start`       | `{}`                                                                                  | `{}`                                                                             |
| `stop`        | `{}`                                                                                  | `{}`                                                                             |
| `reset`       | `{}`                                                                                  | `{}`                                                                             |
| `status`      | `{}`                                                                                  | `{ state, detail?, endpoints, counters }`                                        |
| `action`      | `{ name, input, caller }`                                                             | 액션의 출력                                                                      |
| `runChanged`  | `{ runId \| null, seed }`                                                             | `{}`                                                                             |
| `shutdown`    | `{}`                                                                                  | `{}`. 응답한 뒤 코어가 스스로 종료                                               |

### 4.1 initialize

- `configSchema`, 액션의 `inputSchema`·`outputSchema`는 JSON Schema(draft 2020-12)입니다. glue는 이것을 검증기로 바꿔 설정과 액션 입력을 검증하고 매니페스트에 노출합니다.
- `defaultConfig`는 코어가 자기 환경 변수(`<CORE_ID>_*`)로 만든 부팅 기본값입니다. glue가 §2.1 필드를 합치고 검증합니다.
- `actions`: `{ [name]: { title, description, inputSchema, outputSchema, mutating, surfaces? } }`. 액션 입력 스키마의 최상위 속성 이름 `replica`는 예약되어 있어 쓸 수 없습니다(§6).
- `faults`: 지원하는 결함 종류 목록(`delay`, `error`, `disconnect`, `corrupt` 중).
- 다음 경우 glue는 그 복제를 `error`(`detail`에 이유)로 두고 시작하지 않습니다: `protocolVersion`이 다름 / `kind`가 선언과 다름 / §2.1 필드 이름을 씀 / 액션 입력이 `replica`를 씀 / 스키마가 JSON Schema가 아님 / 응답이 `requestTimeoutMs` 안에 오지 않음.
- 복제가 여럿이면 모든 복제의 `initialize` 응답이 같아야 합니다(`r0` 기준). 다르면 다른 복제를 `error`로 둡니다.

### 4.2 순서

```
spawn → initialize → applyConfig(검증된 설정) → [autoStart면] start
          … status(주기) · action · runChanged · applyConfig …
stop → (프로세스는 살아 있음) → start …
서버 종료 / 복제 수 변경 / 감시의 재시작 → shutdown → 종료
```

- `stop`은 데이터면을 닫을 뿐이고 프로세스는 유지합니다.
- 코어가 `running`이 아닐 때 받은 `applyConfig`는 저장만 하고 `applied`를 돌려줍니다.

### 4.3 seed

- `initialize`와 `runChanged`의 `seed`는 복제마다 다릅니다: `<Run 또는 부팅 seed>:<replicaId>`. 같은 Run seed면 같은 복제는 같은 결과를 냅니다.
- 코어는 seed를 받을 때마다 자기 PRNG를 다시 만들고 결함 규칙의 적용 횟수를 0으로 합니다.

### 4.4 오류

- JSON-RPC `error`로 돌려주고, `error.data.code`에 코드를 넣습니다.
  - 제어면 코드(`VALIDATION_ERROR`, `CORE_NOT_RUNNING` 등)면 glue는 그 코드와 HTTP 상태를 그대로 씁니다.
  - 그 밖의 코드는 `CORE_ERROR`(HTTP 502)로 바꾸고 `details.coreCode`에 원래 코드를 담습니다.
- 요청에 `requestTimeoutMs` 안에 응답이 없으면 glue는 그 호출을 `CORE_TIMEOUT`(HTTP 504)으로 실패시킵니다. 프로세스는 그대로 둡니다(감시가 판단).

## 5. 코어 → glue (알림)

| 메서드  | params                                                                  | 뜻                                                                            |
| ------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `event` | `{ kind, level, summary, payload, correlationId?, latencyMs?, actor? }` | 이벤트. `kind`는 `<core id>.`로 시작. 봉투의 나머지와 `replica`는 glue가 채움 |
| `fault` | `{ ruleId, effects, selector, correlationId? }`                         | 결함을 적용함. glue가 `testbed.fault.injected` 이벤트로 바꿈                  |
| `state` | `{ state, detail? }`                                                    | 상태 변화. glue가 `testbed.core.state`(`replica` 포함)로 바꿈                 |
| `log`   | `{ level, msg }`                                                        | 로그. 이벤트로 남지 않음                                                      |

- glue는 `event`를 받을 때 비밀값 가림과 payload 크기 상한을 한 번 더 적용합니다. `kind` 접두사가 틀린 이벤트는 버리고 `warn` 로그를 남깁니다.
- `eventLevel`이 `info`면 glue가 `debug` 이벤트를 버립니다. 코어가 먼저 걸러도 됩니다.

## 6. 복제

- 설정 `replicas: N`이면 프로세스를 N개 띄웁니다. `replicaId`는 `r0`, `r1`, …, `replicaIndex`는 0부터입니다.
- 데이터면 포트는 코어가 `replicaIndex`로 정합니다(예: 기본 포트 + index. 기본 포트가 `0`이면 모두 임의 포트).
- 이벤트와 `testbed.core.state`에는 `replica`가 붙습니다.
- **전체 상태**: 복제들의 상태 중 다음 순서로 가장 앞에 오는 것입니다: `error` → `starting` → `stopping` → `stopped` → `idle` → `running`. 그래서 모두 `running`일 때만 `running`입니다. 전체 상태가 바뀌면 `replica` 없는 `testbed.core.state`가 나갑니다.
- **카운터**: 전체 카운터는 복제 카운터의 합입니다. 엔드포인트는 복제마다 따로 나열하고 `replica`를 붙입니다.
- `start`·`stop`·`reset`·`applyConfig`·`runChanged`는 모든 복제에 보냅니다.
- **액션**: 입력에 `replica`(예: `"r1"`)를 주면 그 복제에만, 없으면 모두에 보냅니다. 모두에 보낼 때 `replicas`가 1이면 출력을 그대로, 2 이상이면 `{ r0: 출력, r1: 출력, … }`으로 돌려줍니다. 한 복제라도 실패하면 그 복제의 자리에 `{ error: { code, message } }`를 담고, 전체 호출은 성공으로 봅니다. 없는 복제를 지정하면 `VALIDATION_ERROR`입니다.
- `replicas`를 바꾸면 `restart-required`이고, 다음 `stop` → `start`에서 프로세스를 늘리거나(새로 띄워 `initialize`) 줄입니다(뒤 번호부터 `shutdown`).

## 7. 전송

- **로컬 자식 프로세스 (P4)**: stdio. 작업 디렉터리는 저장소 루트입니다.
  - stdout은 프로토콜 전용입니다. JSON-RPC가 아닌 줄이나 1 MiB를 넘는 줄은 버리고 `warn` 로그를 남깁니다.
  - stderr는 줄마다 `info` 로그로 흘려보내고, 복제마다 최근 50줄을 메모리에 둡니다(가림 적용). 대시보드와 종료 이벤트가 이것을 보여 줍니다.
- **원격 워커와 docker compose 코어 (P5)**: 같은 메시지를 WebSocket `/testbed/workers`로 주고받습니다. 연결은 워커가 glue로 겁니다. 워커는 연결 직후 `{ coreId, replicaId }`로 자신을 알리고, glue가 `initialize`를 보냅니다. `TESTBED_CONTROL_TOKEN`이 있으면 워커도 Bearer를 보냅니다.

## 8. 감시 (supervisor)

복제마다 따로 감시합니다.

- **응답 확인**: `pingIntervalMs`마다 `status`를 보냅니다. `pingTimeoutMs` 안에 응답이 없으면 놓친 것으로 셉니다. 연속 3번 놓치면 `testbed.core.process.unresponsive`를 남기고 프로세스를 강제 종료(SIGKILL)한 뒤 비정상 종료로 처리합니다.
- **비정상 종료**: 서버가 요청하지 않았는데 프로세스가 끝나면 `testbed.core.process.exited`(종료 코드, 시그널, stderr 마지막 20줄)를 남기고 복제를 `error`로 둡니다. 그 복제에 걸려 있던 요청은 `CORE_ERROR`(`details.coreCode: 'EXITED'`)로 실패합니다.
- **재시작**: `restart: 'on-failure'`면 1초부터 2배씩, 최대 30초 간격으로 다시 띄웁니다(`testbed.core.process.restarting`에 시도 횟수와 대기 시간). 다시 띄우면 `initialize` → `applyConfig` → 종료 전 상태가 `running`이었으면 `start`까지 합니다.
  - 재시작 횟수는 복제가 60초 동안 문제없이 `running`이면 0으로 돌아갑니다.
  - `maxRestarts`를 넘으면 더 띄우지 않고 `error`(`detail: 'restart limit reached'`)로 둡니다. 사람이나 에이전트가 `start`를 부르면 횟수를 0으로 하고 다시 띄웁니다.
  - `restart: 'never'`면 `error`로 두고, `start`를 부르면 다시 띄웁니다.
- **종료**: 서버 종료 때는 보일러플레이트의 graceful shutdown 흐름 안에서, 모든 코어를 `stop`한 뒤 복제마다 `shutdown`을 보냅니다. `shutdownGraceMs` 뒤에도 살아 있으면 SIGTERM, 다시 `shutdownGraceMs` 뒤 SIGKILL입니다. 서버가 끝난 뒤 남는 자식 프로세스는 없어야 합니다.

### 8.1 예약된 이벤트

| kind                                | level | 언제                       |
| ----------------------------------- | ----- | -------------------------- |
| `testbed.core.process.spawned`      | info  | 프로세스를 띄움(pid, 명령) |
| `testbed.core.process.exited`       | warn  | 서버가 요청하지 않은 종료  |
| `testbed.core.process.restarting`   | warn  | 재시작 대기 시작           |
| `testbed.core.process.unresponsive` | warn  | 응답 확인을 연속 3번 놓침  |

모두 `core`는 외부 코어의 id, `replica`는 해당 복제, `actor`는 `system`입니다.

## 9. 재현성

- 외부 코어의 무작위는 공통 런타임의 `SeededRng`과 **같은 알고리즘**으로 합니다. seed 문자열(UTF-8)의 sha256 앞 16바이트를 little-endian uint32 4개(a, b, c, d)로 읽어 sfc32를 초기화합니다. `next()`는 [0, 1) 실수(`t / 2^32`), `int(min, max)`는 `min + floor(next() * (max - min + 1))`입니다.
- 결함 판정도 공통 런타임의 `FaultDecider`와 같은 순서로 합니다: 규칙을 차례로 봄 → `times`를 채웠으면 건너뜀 → `match`가 안 맞으면 건너뜀 → `probability < 1`일 때만 `next()` 한 번(`>= probability`면 건너뜀) → 적용이면 `delayMs`가 범위일 때만 `int()` 한 번.
- 참조 어댑터는 이 둘을 구현하고, 같은 seed에서 Bun과 같은 값을 내는지 시험합니다.

## 10. 참조 구현

- `examples/python-core/`: Python 어댑터(`testbed_core`)와 예제 코어 `py-echo`. Python 3.11 이상, 표준 라이브러리만 씁니다.
- 다른 언어는 필요해질 때 추가합니다.
