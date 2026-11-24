# 이벤트

## 1. 이벤트 버스

- 프로세스 안의 pub/sub입니다. 구독자는 링버퍼, Run 저장소, WS 브로드캐스터, `wait_for` 대기자입니다.
- **링버퍼**: 기본 5000건(`TESTBED_EVENT_BUFFER`). 대시보드를 늦게 연 탭과 Run 밖의 이벤트 조회에 씁니다.
- **Run 저장소**: 리포지토리 패턴의 드라이버로 둡니다(`TESTBED_RUN_STORE`).
  - `memory`: 기본값. 재시작하면 사라짐
  - `file`: `TESTBED_DATA_DIR/runs/<runId>.jsonl`(이벤트 한 줄에 하나) + `TESTBED_DATA_DIR/runs/<runId>.meta.json`(Run 메타). 공용 서버 권장
  - DB는 쓰지 않습니다. JSONL이 그대로 내보내기 형식이 되기 때문입니다.
  - 보존: 최근 `TESTBED_RUN_RETENTION`(기본 50)개 Run. 넘으면 가장 오래 전에 닫힌 Run부터 지웁니다.
- **배압**: 이벤트가 폭주하면(부하 시험) 다음 순서로 대응합니다.
  1. WS 전송을 표본화하고, 대시보드에 "n건 생략"을 표시합니다. 링버퍼와 Run 저장소에는 모두 남습니다.
  2. Run 저장소는 배치로 씁니다.
  3. 코어 설정 `eventLevel`로 `debug` 이벤트를 끌 수 있습니다.

## 2. 공통 이벤트 봉투

```ts
interface TestbedEvent<P = unknown> {
  seq: number; // 인스턴스(부팅) 안에서 단조 증가. 부팅마다 0부터
  id: string; // `${instanceId}:${seq}` — 이 값이 그대로 커서가 됨
  ts: UtcIsoString;
  runId: string | null; // Run 밖이면 null
  core: string; // 코어 id. 공통 런타임 자신은 'testbed'
  replica?: string;
  kind: string; // '<core>.<대상>.<동사>' 예: 'echo.connection.opened', 'llm.completion.responded'
  level: 'debug' | 'info' | 'warn' | 'error';
  actor: 'product' | 'human' | 'agent' | 'ci' | 'system';
  correlationId?: string; // 요청과 응답, 단계와 그 결과를 묶음
  latencyMs?: number; // 있으면 공통 통계 패널이 지연을 집계
  summary: string; // 한 줄 요약 — 로그 표시와 에이전트 판독용 (필수)
  payload: P; // 코어별. 스키마는 src/shared/testbed/cores/<core>/events.ts
  truncated?: boolean;
}
```

- **kind**: `<core>.<대상>.<동사>`. 동사는 과거형입니다(`opened`, `received`, `responded`, `failed`). 모두 소문자이고 단어는 `-`로 잇습니다.
- **summary**: 사람이 로그를 훑을 때와 에이전트가 적은 토큰으로 상황을 파악할 때 핵심입니다. 한 줄, 200자 이내입니다. 스펙의 이벤트 표에 kind별 형식을 적습니다. 예: `echo 32B from 127.0.0.1:51234 (conn c-7)`.

### 2.1 예약된 kind (`testbed.*`)

| kind                                                            | 뜻                    |
| --------------------------------------------------------------- | --------------------- |
| `testbed.core.state`                                            | 코어 상태 변화        |
| `testbed.control.invoked`                                       | 누가 어떤 조작을 했나 |
| `testbed.run.started` / `testbed.run.ended`                     | Run 시작·종료         |
| `testbed.lease.acquired` / `.released` / `.expired` / `.denied` | 제어 락 변화          |
| `testbed.check.evaluated`                                       | 판정 결과             |
| `testbed.fault.injected`                                        | 결함 주입             |

코어는 `testbed.*` kind를 직접 내보내지 않습니다. 공통 런타임이 냅니다.

## 3. 인스턴스와 커서

- `instanceId`는 프로세스가 부팅할 때마다 새로 만듭니다. `seq`는 부팅마다 0부터 다시 셉니다.
- 커서는 `<instanceId>:<seq>` 문자열입니다(이벤트의 `id`와 같음). `query_events`, `GET /events`, `wait_for`는 이 커서를 `after`로 받습니다.
- 현재 인스턴스가 아닌 커서가 오면 `CURSOR_STALE` 오류를 냅니다. 오류 문장은 "테스트베드가 재시작됨. 새 커서 `<현재 instanceId>:0`부터 다시 조회"이고, `details`에 새 커서를 담습니다.
- 지난 부팅의 Run(file 저장소)은 그때의 `instanceId`가 붙은 이벤트 그대로 `GET /runs/:id`, `export_run`으로 볼 수 있습니다.
- 재시작 때문에 닫히지 못한 Run은 다음 부팅 때 `endedBy.actor: 'system'`, `endReason: 'restart'`로 닫습니다.

## 4. 크기와 비밀값

- **크기 상한**: payload는 기본 16KB(`TESTBED_MAX_PAYLOAD_BYTES`)입니다. 넘으면 payload를 `{ preview, bytes }`로 바꾸고 `truncated: true`를 붙입니다. `preview`는 원래 payload JSON의 앞부분(글자 경계에서 잘라 전체가 상한 안에 들어감), `bytes`는 원래 크기입니다. 큰 본문이 꼭 필요한 코어는 본문 대신 sha256과 길이를 함께 담습니다.
- **비밀값 가림**: `Authorization`, `Cookie`, `Set-Cookie`, 이름이 `-key`로 끝나거나 `token`·`secret`·`password`를 포함하는 헤더·필드는 공통 유틸로 가립니다.
  - 가린 값의 형식: `앞 4자…(길이 n, sha256:앞 12자)`. 예: `sk-a…(len 51, sha256:3f9a0c1d22be)`
  - 원문은 링버퍼, Run 저장소, 로그 어디에도 남기지 않습니다.
  - 가림 대상을 늘려야 하는 코어는 공통 유틸에 키를 추가해서 넘깁니다. 직접 가리지 않습니다.
  - 가림과 크기 상한은 이벤트 버스가 `emit` 때 적용합니다. 코어는 추가 키를 `redactKeys`로 넘깁니다.

## 5. 코드 위치

| 무엇                                        | 위치                                               |
| ------------------------------------------- | -------------------------------------------------- |
| 봉투·필터·`Caller` 타입                     | `src/shared/testbed/events.ts`                     |
| Run 메타·요약 타입                          | `src/shared/testbed/runs.ts`                       |
| 이벤트 버스, 링버퍼, 필터·커서              | `src/server/testbed/events/`                       |
| Run 관리(`RunManager`), 저장소, 요약, check | `src/server/testbed/runs/`                         |
| 가림(`redact`), 크기 상한(`limitPayload`)   | `src/server/testbed/redact.ts`, `payload-limit.ts` |
| `CURSOR_STALE`·`RUN_ACTIVE`(`TestbedError`) | `src/server/testbed/errors.ts`                     |
