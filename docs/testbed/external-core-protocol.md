# 외부 프로세스 코어 프로토콜

Bun 밖에서 도는 코어(Python, Java 등)와 glue가 주고받는 규약입니다. 구현은 `testbed-base` P4, 원격 워커 전송은 그다음 단계입니다.

## 1. 언제 쓰나

다음 경우에만 씁니다. 그 외에는 in-proc 코어([core-contract.md](core-contract.md))를 씁니다.

- 다른 언어 SDK가 필요함(예: Java 전용 클라이언트 라이브러리)
- Python 전용 모듈이 필요함
- 대량 연산
- Bun으로 낼 수 없는 성능

외부 코어를 쓰면 스펙의 "구성" 절에 위 이유 중 무엇인지 적습니다.

## 2. 메시지 형식

- JSON-RPC 2.0. 프레이밍은 줄 단위(NDJSON)이며, 메시지 하나가 한 줄입니다(UTF-8, 줄 안에 개행 없음).
- 요청은 glue → 코어 방향뿐입니다. 코어 → glue는 알림(`id` 없음)만 보냅니다.

### 2.1 glue → 코어 (요청)

| 메서드        | params                                                                | result                                                            |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `initialize`  | `{ coreId, replicaId, config, seed, runId \| null, protocolVersion }` | `{ protocolVersion, kind, title, configSchema, actions, faults }` |
| `start`       | `{}`                                                                  | `{}`                                                              |
| `stop`        | `{}`                                                                  | `{}`                                                              |
| `reset`       | `{}`                                                                  | `{}`                                                              |
| `applyConfig` | `{ config }`                                                          | `{ result: 'applied' \| 'restart-required' }`                     |
| `status`      | `{}`                                                                  | `CoreStatus` (state, endpoints, counters, 코어별 요약)            |
| `action`      | `{ name, input, caller }`                                             | 액션의 `output`                                                   |
| `runChanged`  | `{ runId \| null, seed \| null }`                                     | `{}`                                                              |
| `shutdown`    | `{}`                                                                  | `{}` 를 보낸 뒤 코어가 스스로 종료                                |

- `protocolVersion`은 `"1"`부터 시작합니다. 서로 다르면 glue는 그 코어를 `error` 상태로 두고 시작하지 않습니다.
- `initialize` 응답의 `configSchema`와 액션의 `inputSchema`·`outputSchema`는 JSON Schema입니다. glue가 이것으로 검증하고 매니페스트에 노출합니다.
- `runChanged`는 Run이 열리거나 닫힐 때 보냅니다. 새 Run에 seed가 있으면 코어는 자기 rng를 그 seed로 다시 맞춥니다.
- 오류는 JSON-RPC `error`로 돌려줍니다. `error.data.code`에는 제어면 오류 코드(`CORE_NOT_RUNNING` 등)나 코어가 정한 코드를 넣습니다.

### 2.2 코어 → glue (알림)

| 메서드  | params                                                                               | 뜻                                                   |
| ------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `event` | `CoreEventInput` (kind, level, summary, payload, correlationId?, latencyMs?, actor?) | 이벤트. 봉투의 공통 필드와 `replica`는 glue가 채움   |
| `log`   | `{ level, msg }`                                                                     | 로그. 이벤트로 남지 않음                             |
| `state` | `{ state, detail? }`                                                                 | 상태 변화. glue가 `testbed.core.state` 이벤트로 바꿈 |

- 비밀값 가림은 glue가 `event`를 받을 때 한 번 더 적용합니다. 코어도 가린 값을 보내는 것이 원칙입니다.

## 3. 전송

- **로컬 자식 프로세스**: stdio. stdout은 프로토콜 전용이고, stderr는 glue가 로그(`level: info`)로 흘려보냅니다. stdout에 프로토콜이 아닌 줄이 오면 glue는 그 줄을 `warn` 로그로 남기고 버립니다.
- **원격 워커와 docker compose 코어**: 같은 메시지를 WebSocket `/testbed/workers`로 주고받습니다. 연결은 워커가 glue로 겁니다. 워커는 연결 직후 `{ coreId, replicaId }`로 자신을 알리고, glue가 `initialize`를 보냅니다. `TESTBED_CONTROL_TOKEN`이 있으면 워커도 Bearer를 보냅니다.

## 4. 감시 (supervisor)

- glue는 `status`를 주기적으로 보내 응답 시간을 봅니다. 기본 간격 5초, 응답 제한 3초입니다. 연속 3번 응답이 없으면 코어를 `error`로 봅니다.
- 재시작 정책(코어 설정 `restart`): `never` 또는 `on-failure`입니다. `on-failure`는 지수 백오프(1초부터 2배씩, 최대 30초)로 최대 `maxRestarts`(기본 5)번 다시 띄웁니다.
- 종료: `shutdown`을 보내고 유예(기본 5초) 뒤에도 살아 있으면 SIGTERM, 다시 5초 뒤 SIGKILL을 보냅니다. 보일러플레이트의 graceful shutdown 흐름에 묶습니다.
- 위 숫자들은 기본값이며, 코어 설정으로 바꿀 수 있습니다.

## 5. 복제

- 코어 설정 `replicas: N`이면 N개를 띄웁니다. `replicaId`는 `r0`, `r1`, … 입니다.
- 이벤트에는 `replica`가 붙습니다.
- `status`는 전체 요약과 복제별 상태를 함께 줍니다. 전체 상태는 하나라도 `error`면 `error`, 모두 `running`이면 `running`입니다.
- 액션은 전체에 보내거나(`replica` 생략) 특정 복제를 지정합니다(`replica: 'r1'`). 전체에 보내면 결과는 복제 id를 키로 모읍니다.

## 6. 참조 구현

- `examples/python-core/`에 Python 어댑터와 echo 예제를 둡니다(P4). 다른 언어는 필요해질 때 추가합니다.
