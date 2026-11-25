# testbed-base 스펙

`testbed-base` 자체를 만드는 단계별 스펙입니다. 지금은 P0–P4를 다룹니다. 공통 규약은 [docs/testbed/](testbed/README.md)가 원본이고, 이 문서는 그 규약을 **이 저장소에 처음 구현하는 순서와 수용 기준**을 정합니다.

## 변경 이력

| 날짜       | 바뀐 절                                                                                                                                                                                                                                                                    | 영향받는 마일스톤 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 2026-11-25 | 11절: P4(M11–M14 외부 프로세스 코어, 감시·복제, Python 참조 구현, 표면 반영) 추가. 3절(예제 코어), 12절 갱신. `testbed/external-core-protocol.md` 개정(initialize에서 설정 분리, 설정 필드, 오류 변환, 감시 이벤트, 언어 간 재현성), `testbed/ports.md`에 40002–40008 등록 | M11–M14           |
| 2026-11-24 | 11절: P2(M5–M6 MCP 어댑터, 스모크)와 P3(M7–M10 대시보드, UI 자동화) 추가. 10절, 12절, 13절 갱신(13절 1번은 M1 성공으로 삭제)                                                                                                                                               | M5–M10            |
| 2026-11-24 | 2절: M1 결과(MCP SDK 1.32.2, 웹 표준 전송을 `Bun.serve`에 바로 붙임)                                                                                                                                                                                                       | M1, P2            |
| 2026-11-24 | 11절 M0: 데모 제거 업그레이드 가이드(보일러플레이트 머지 때 충돌 해결 원칙) 추가                                                                                                                                                                                           | M0                |
| 2026-11-24 | 최초 작성(P0–P1)                                                                                                                                                                                                                                                           | M0–M4             |

## 1. 목적

- 모든 테스트베드가 공유하는 공통 런타임(코어 호스트, 이벤트, Run, 제어 서비스, 제어 락, REST/WS, 매니페스트)을 한 번만 만듭니다.
- 각 테스트베드 레포는 이 저장소의 이력을 이어받아 `cores/<id>/`만 추가하면 되게 합니다.
- 공통 런타임이 실제로 쓸 만한지 확인하기 위해 샘플 코어(TCP echo)를 함께 만듭니다.

## 2. 확정된 전제

- [docs/testbed/architecture.md](testbed/architecture.md)의 결정을 모두 따릅니다.
- 보일러플레이트의 `main` 이력을 이어받았습니다(완료). 보일러플레이트 쪽 파일은 업스트림 머지 충돌을 줄이기 위해 **필요한 만큼만** 고칩니다.
- `migrations/`는 그대로 둡니다. 새 마이그레이션을 만들지 않습니다. 기본값이 `DB_DRIVER=memory`이므로 테스트베드는 DB 없이 뜹니다.
- 보일러플레이트의 회원 로그인(OIDC) 코드와 디자인 시스템 페이지는 유지합니다. 공용 서버에서 사람 로그인에 씁니다.
- `pubsub/`는 유지합니다(데모가 아님).
- P1에는 MCP 어댑터, 대시보드 화면, 외부 코어를 넣지 않습니다(12절).
- **MCP SDK (M1 결과)**: `@modelcontextprotocol/sdk` 1.32.2를 씁니다. SDK의
  `WebStandardStreamableHTTPServerTransport`(`server/webStandardStreamableHttp.js`)가 웹 표준 `Request`를 받아
  `Response`를 돌려주므로 `Bun.serve` 라우트 핸들러에 그대로 붙습니다. Node `http` 객체를 흉내 내지 않습니다.
  MCP 세션마다 전송과 `McpServer`를 하나씩 만들고 `Mcp-Session-Id`로 고릅니다(`onsessioninitialized`에서 등록,
  `onsessionclosed`에서 제거). 세션 없는 요청은 `initialize`만 받고, 끝난 세션의 요청은 404입니다. 도구 입력
  스키마는 `@shared/validation`의 `s`(zod/mini)를 그대로 씁니다. JSON 응답(`enableJsonResponse`)과 기본 SSE 응답
  모두 확인했습니다(`src/server/testbed/mcp/mcp-sdk.integration.test.ts`).

## 3. 구성

| 코어 id               | 유형      | 실행         | 복제                     | 데이터면                                 |
| --------------------- | --------- | ------------ | ------------------------ | ---------------------------------------- |
| `sample`              | `passive` | in-proc      | 1                        | TCP `40001` (`SAMPLE_PORT`)              |
| `py-echo` (예제, M13) | `passive` | 외부(Python) | 1–7 (`PY_ECHO_REPLICAS`) | TCP `40002` + 복제 번호 (`PY_ECHO_PORT`) |

- `py-echo`는 외부 코어 참조 구현의 예제입니다. 외부 프로세스를 쓰는 이유는 "다른 언어 SDK"의 자리 표시(Python 어댑터 시연)입니다. `TESTBED_EXAMPLE_CORES=py-echo`일 때만 등록됩니다.
- 포트 블록: `40000–40009`([testbed/ports.md](testbed/ports.md)에 등록됨). `PORT` 기본값은 `40000`.

## 4. 상호작용 프로토콜 (샘플 코어)

- 평문 TCP입니다. 제품(또는 시험 클라이언트)이 `40001`에 연결해 바이트를 보내면, 받은 데이터 조각(chunk)을 **그대로** 돌려보냅니다.
- 메시지 경계는 없습니다. 받은 조각 하나에 응답 하나입니다.
- 연결마다 `c-<순번>` id를 붙입니다(부팅마다 1부터).

## 5. 코어 동작 명세 (샘플 코어)

| 상황                                           | 동작                                                                        | 이벤트                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| 연결 수락                                      | 연결 id 부여                                                                | `sample.connection.opened`                          |
| 열린 연결이 `maxConnections`와 같을 때 새 연결 | 수락한 뒤 바로 닫음                                                         | `sample.connection.rejected`                        |
| 데이터 수신                                    | 결함 판정 → 그대로 돌려보냄                                                 | `sample.data.received`, `sample.data.echoed`        |
| 수신 조각이 `maxChunkBytes`보다 큼             | 돌려보내지 않고 연결을 닫음(`reason: 'too-large'`)                          | `sample.data.too-large`, `sample.connection.closed` |
| `idleTimeoutMs` 동안 수신 없음(0이면 끔)       | 연결을 닫음(`reason: 'idle'`)                                               | `sample.connection.closed`                          |
| 클라이언트가 닫음                              | 정리                                                                        | `sample.connection.closed`(`client`)                |
| `stop`                                         | 열린 연결을 모두 닫고(`reason: 'stop'`) 리스너를 닫음                       | `sample.connection.closed` × n                      |
| `reset`                                        | 열린 연결을 모두 닫고 카운터·연결 순번·결함 `times`를 초기화. 리스너는 유지 | `sample.connection.closed` × n                      |
| 포트를 열 수 없음                              | `error` 상태로 감. `detail`에 OS 오류 코드(`EADDRINUSE`, `EACCES` 등)       | `testbed.core.state`                                |
| `broadcast` 액션                               | 열린 연결 모두에 `text`(UTF-8)를 보냄. 결함은 적용하지 않음                 | `sample.broadcast.sent`                             |

- `status().counters`: `connectionsOpen`, `connectionsTotal`, `bytesIn`, `bytesOut`.
- `status().endpoints`: `[{ name: 'echo', protocol: 'tcp', url: 'tcp://<TESTBED_PUBLIC_URL의 호스트>:<port>' }]`.

## 6. 이벤트 (샘플 코어)

| kind                         | level | 언제             | summary 형식                                             | payload 필드                                                                     |
| ---------------------------- | ----- | ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `sample.connection.opened`   | info  | 연결 수락        | `conn c-3 opened from 127.0.0.1:51234`                   | `connId`, `remote`                                                               |
| `sample.connection.rejected` | warn  | 연결 수 초과     | `conn rejected from 127.0.0.1:51240 (max 100)`           | `remote`, `max`                                                                  |
| `sample.data.received`       | debug | 조각 수신        | `c-3 received 32B`                                       | `connId`, `bytes`                                                                |
| `sample.data.echoed`         | info  | 조각을 돌려보냄  | `c-3 echoed 32B in 4ms` (결함이면 끝에 ` [fault f1]`)    | `connId`, `bytes`, `preview`(앞 64바이트, UTF-8 손실 허용), `sha256`, `faultId?` |
| `sample.data.too-large`      | warn  | 조각이 상한 초과 | `c-3 chunk 70000B > max 65536B, closing`                 | `connId`, `bytes`, `max`                                                         |
| `sample.connection.closed`   | info  | 연결 닫힘        | `conn c-3 closed (client) after 12.3s, in 320B out 320B` | `connId`, `reason`, `durationMs`, `bytesIn`, `bytesOut`                          |
| `sample.broadcast.sent`      | info  | `broadcast` 실행 | `broadcast 5B to 2 conns`                                | `bytes`, `connections`                                                           |

- `actor`: 데이터면 이벤트는 `product`, `broadcast`는 호출한 쪽의 actor입니다.
- `correlationId`: 연결 단위로 `connId`를 씁니다.
- `latencyMs`: `sample.data.echoed`에만 둡니다. 수신부터 쓰기 완료까지(결함 지연 포함).
- `reason` 값: `client` | `server` | `idle` | `too-large` | `fault` | `stop`.

## 7. 설정 (샘플 코어)

| 이름             | 타입          | 기본    | 범위              | env                      | 런타임 변경 | 재시작 필요 |
| ---------------- | ------------- | ------- | ----------------- | ------------------------ | ----------- | ----------- |
| `port`           | int           | `40001` | 0–65535 (0=임의)  | `SAMPLE_PORT`            | 가능        | 예          |
| `autoStart`      | boolean       | `true`  | –                 | `SAMPLE_AUTO_START`      | 불가        | –           |
| `maxConnections` | int           | `100`   | 1–10000           | `SAMPLE_MAX_CONNECTIONS` | 가능        | 아니오      |
| `maxChunkBytes`  | int           | `65536` | 1–1048576         | `SAMPLE_MAX_CHUNK_BYTES` | 가능        | 아니오      |
| `idleTimeoutMs`  | int           | `0`     | 0–3600000         | `SAMPLE_IDLE_TIMEOUT_MS` | 가능        | 아니오      |
| `eventLevel`     | enum          | `info`  | `debug` \| `info` | –                        | 가능        | 아니오      |
| `faults`         | `FaultRule[]` | `[]`    | 8절               | –                        | 가능        | 아니오      |

- `maxConnections`를 현재 열린 수보다 작게 바꾸면 이미 열린 연결은 닫지 않습니다. 새 연결부터 적용합니다.

## 8. 결함 주입 (샘플 코어)

| 지원 종류    | 선택자(match 키)          | 적용 방식                                          |
| ------------ | ------------------------- | -------------------------------------------------- |
| `delay`      | `connId`, `remoteAddress` | `delayMs`만큼 기다린 뒤 돌려보냄                   |
| `disconnect` | `connId`, `remoteAddress` | 돌려보내지 않고 연결을 닫음(`reason: 'fault'`)     |
| `corrupt`    | `connId`, `remoteAddress` | 각 바이트를 `0xFF`와 XOR해서 돌려보냄. 길이는 같음 |

- `error`는 지원하지 않습니다(TCP echo에는 오류 응답이 없음). 지정하면 설정 검증에서 거절합니다.
- 판정은 받은 조각마다 한 번입니다.

## 9. 제어 표면

| 액션        | 입력                         | 출력               | 부작용                       | 락  | REST | MCP | UI  |
| ----------- | ---------------------------- | ------------------ | ---------------------------- | --- | ---- | --- | --- |
| `broadcast` | `{ text: string(1–4096자) }` | `{ sent: number }` | 열린 연결 모두에 데이터 전송 | ●   | ●    | P2  | P3  |

- MCP와 UI 노출은 자동 노출로 생깁니다. MCP 도구 `sample_broadcast`는 M5·M6, 대시보드 액션 폼은 M8·M10에서 확인합니다.
- 공통 도구 중 한쪽에만 있는 것: 제어 락의 획득·해제는 MCP(`acquire_control`·`release_control`)와 REST(`/lease`)에만 있고 대시보드에는 없습니다. 사람은 락을 잡지 않기 때문입니다(설계상 확정).

## 10. 대시보드

P3(M7–M10)에서 만듭니다. 영역, 패널 슬롯, 편집 잠김 래퍼, testid는 11절의 M7–M10과 "대시보드 testid" 표를 따릅니다. 샘플 코어는 고유 패널을 두지 않습니다(공통 컴포넌트만으로 확인).

## 11. 마일스톤과 수용 기준

마일스톤 하나가 PR 하나입니다. 순서대로 진행합니다.

### M0 — P0: 보일러플레이트 정리

**범위**

1. 데모 제거: Todos와 채팅에 속한 클라이언트 페이지·훅·테스트, 서버 라우트·서비스·리포지토리 구현·실시간 게이트웨이·presence, 공유 도메인 타입, i18n 메시지, testid, `scripts/chat-load.ts`와 `chat:load` 스크립트. `/`는 빈 자리 페이지로 바꿉니다.
2. 기본값: `DB_DRIVER` 기본 `memory`(`config.ts`와 `.env.example`), `AUTH_DRIVER` 기본 `none`, `PORT` 기본 `40000`(`.env.example`, Dockerfile의 `ENV`·`EXPOSE`).
3. `package.json`의 `name`을 `testbed-base`로 바꿉니다.
4. GitHub Actions: 기존 `ci.yml`은 그대로 두고, `main` push일 때만 도는 이미지 job을 추가합니다. `check`가 통과한 뒤 Docker 이미지를 빌드해 `ghcr.io/hwahee/testbed-base`에 `:<git sha>`와 `:latest`로 push합니다(`permissions: packages: write`, `GITHUB_TOKEN` 사용).
5. `README.md`를 테스트베드 기준으로 다시 씁니다: 이 저장소가 무엇인지, 기동 방법, [docs/testbed/](testbed/README.md)와 이 스펙으로 가는 링크, 새 테스트베드 레포를 만드는 법(이력 이어받기).
6. `docs/upgrade-guides/README.md` 목록에 "출처" 열(`boilerplate` / `testbed-base`)을 추가합니다. 기존 항목은 `boilerplate`입니다.
7. 업그레이드 가이드 `docs/upgrade-guides/2026-11-testbed-demo-removal.md`를 추가하고 목록에 올립니다(출처 `testbed-base`). 가이드 규칙(같은 폴더 README의 "담을 것")을 따르고, 특히 다음을 담습니다.
   - 지운 경로 목록(폴더·파일 단위).
   - **충돌 해결 원칙**: 보일러플레이트를 머지할 때 지운 데모 파일에서 "한쪽은 수정, 한쪽은 삭제" 충돌이 나면 **삭제를 유지**합니다(`git rm <경로>`). 보일러플레이트가 데모와 공통 코드를 함께 고친 경우에는 공통 코드 쪽 변경만 받고, 데모를 되살리지 않습니다.
   - 보일러플레이트가 새 데모(예시 기능)를 추가했으면 머지 후 같은 원칙으로 지우고, 지운 경로를 이 가이드의 목록에 더합니다.
   - 적용 여부 확인 방법: 아래 수용 기준의 `git grep` 명령과 폴더 부재 확인.

**수용 기준**

- `bun run check` 통과.
- `git grep -n -i -E 'todo-service|todos-page|chat-gateway|chat-service|home-chat|chat-room|presence' -- src scripts` 결과가 비어 있음. `src/client/chat/`, `src/server/presence/`, `src/server/realtime/` 폴더가 없음.
- `.env` 없이 `bun run dev` → `curl -s localhost:40000/` 가 200이고, 빈 자리 페이지의 testid가 들어 있음.
- `docker build` 성공, 컨테이너를 띄우면 `40000`에서 200.
- 워크플로 파일에 이미지 job이 있고 `if: github.ref == 'refs/heads/main'` 조건이 붙어 있음.
- `docs/upgrade-guides/2026-11-testbed-demo-removal.md`가 있고, 목록에 출처 `testbed-base`로 올라 있으며, 지운 경로 목록이 실제로 지운 경로와 일치함.

### M1 — P1-a: MCP SDK 사전 확인

**범위**

- 공식 MCP TypeScript SDK(`@modelcontextprotocol/sdk`)를 의존성에 추가하고, Bun에서 Streamable HTTP 서버로 쓸 수 있는지 확인하는 통합 테스트를 둡니다.
- 핵심 질문: `Bun.serve`의 `fetch` 핸들러(Request/Response)에 SDK의 서버 전송을 붙일 수 있는가. Node `http` 객체를 흉내 내야 한다면 그 방법도 시험합니다.
- 테스트가 확인할 것: 세션 생성(`initialize` 응답의 `Mcp-Session-Id`), `tools/list`, `tools/call`(도구 하나: 입력 문자열을 그대로 돌려줌), 같은 세션으로 두 번째 호출, `DELETE`로 세션 종료 후 그 세션으로 호출하면 실패.
- 결과를 이 문서 변경 이력과 2절에 적습니다(사용한 SDK 버전, 붙인 방법).

**수용 기준**

- 위 테스트가 `bun test`로 통과하고 `bun run check` 통과.
- **테스트를 통과시킬 수 없으면 M2로 넘어가지 않고 멈춥니다.** 시도한 방법과 실패 내용을 PR에 적고 13절 1번을 사람에게 묻습니다.

### M2 — P1-b: 이벤트, Run, check, 재현성 도구

**범위**

- 이벤트 봉투 타입과 이벤트 버스, 링버퍼, 커서(`<instanceId>:<seq>`)와 `CURSOR_STALE` ([testbed/events.md](testbed/events.md)).
- Run 저장소 드라이버 `memory`, `file` 과 보존 정책, 재시작으로 닫히지 못한 Run 정리.
- Run 시작·종료·요약, `endActive`, Run 메타, check ([testbed/runs-and-checks.md](testbed/runs-and-checks.md)).
- `SeededRng`, 결함 판정 도우미 `FaultDecider` ([testbed/faults-and-seed.md](testbed/faults-and-seed.md)).
- 비밀값 가림 유틸과 payload 크기 상한.
- ESLint 규칙: `src/server/testbed/cores/**`에서 `Math.random` 금지.
- 이 단계에서는 제어 서비스 없이 모듈 함수로 시험합니다.

**수용 기준** (모두 `bun test`)

- 링버퍼: 상한 5건으로 만들고 7건을 넣으면 가장 오래된 2건이 빠지고 `seq`는 계속 증가.
- 커서: `after` 커서 다음 이벤트만 돌려줌. 다른 `instanceId`의 커서 → `CURSOR_STALE`, `details`에 `<현재 instanceId>:0`.
- Run: 열린 Run이 있을 때 다시 시작 → `RUN_ACTIVE`와 열린 Run 정보. `endActive: true` → 앞 Run `endReason: 'replaced'`, 새 Run 열림.
- file 저장소: 임시 디렉터리에 Run 하나를 기록하고 저장소를 새로 만들면(재시작 흉내) 그 Run이 `endReason: 'restart'`로 닫혀 있고 이벤트를 JSONL로 읽을 수 있음. 보존 3으로 Run 4개를 닫으면 가장 오래된 1개가 지워짐.
- check: `count: '==2'`, `'>=1'`, `'<=0'`, `none: true` 각각 pass/fail이 맞고, 판정마다 `testbed.check.evaluated`가 남음.
- rng: 같은 seed로 만든 두 `SeededRng`의 처음 1000개 값이 같음. `FaultDecider`는 같은 seed·같은 요청 순서에서 같은 판정 순서를 냄. `times: 2` 규칙은 두 번 적용 후 비활성.
- 가림: `Authorization: Bearer sk-abcdef…`가 `앞 4자…(len n, sha256:12자)` 형식이 되고, 원문이 링버퍼·file 저장소 어디에도 없음.
- 크기: 20KB payload → 16KB 이하로 잘리고 `truncated: true`.
- `cores/` 아래 파일에서 `Math.random()`을 쓰면 `bun run lint`가 실패함(규칙 테스트 또는 fixture로 확인).

### M3 — P1-c: 코어 호스트와 샘플 코어

**범위**

- in-proc 코어 호스트: 코어 등록, 상태 기계와 `testbed.core.state`, `autoStart`, `applyConfig`/`restart-required`, env 기본값 → 설정 검증 ([testbed/core-contract.md](testbed/core-contract.md)).
- 샘플 코어 `sample`(3–9절)을 `src/server/testbed/cores/sample/`에.
- 서버 부팅에 코어 호스트를 묶고, graceful shutdown 때 모든 코어를 `stop`.

**수용 기준** (모두 `bun test`, 포트는 `0`으로 열고 `endpoints`에서 주소를 읽음)

- 연결 → 32바이트 전송 → 같은 32바이트 수신. 이벤트 `opened`, `echoed`(`latencyMs` 있음) 순서로 남음. `eventLevel: debug`일 때만 `received`가 남음.
- `maxConnections: 1`에서 두 번째 연결 → 바로 닫히고 `rejected`(warn).
- `maxChunkBytes: 16`에서 32바이트 전송 → 응답 없이 닫히고 `too-large`, `closed(reason: 'too-large')`.
- `idleTimeoutMs: 100` → 아무것도 안 보내면 닫히고 `closed(reason: 'idle')`.
- 결함: `delay`(`delayMs: 200`) → `latencyMs ≥ 200`. `disconnect` → 응답 없이 닫힘, `closed(reason: 'fault')`, `testbed.fault.injected`가 같은 `correlationId`로 남음. `corrupt` → 각 바이트가 `0xFF` XOR. `error` 지정 → 설정 검증 실패.
- 이미 쓰는 포트로 시작 → `error` 상태, `detail`에 `EADDRINUSE`.
- `port` 변경 → `restart-required`, `stop`→`start` 후 새 포트에서 동작.
- `reset` → 열린 연결이 닫히고 `counters`가 0, 리스너는 그대로.
- `broadcast({ text: 'hello' })` → 열린 연결 2개 모두 `hello` 수신, 결과 `{ sent: 2 }`.

### M4 — P1-d: 제어 서비스, 제어 락, REST, WS, 매니페스트

**범위**

- 제어 서비스 함수 전부와 `testbed.control.invoked` ([testbed/control-plane.md](testbed/control-plane.md) §1).
- 제어 락: MCP 세션용 보유 로직(자동 획득·TTL 연장·만료)은 세션 id를 받는 함수로 만들어 두고, P2의 MCP 어댑터가 부릅니다. REST `leaseId` 방식은 이 단계에서 완성합니다(§2).
- REST 어댑터 `/testbed/api/*` 전부(§3)와 오류 코드·HTTP 상태.
- WS `/testbed/ws`: `snapshot`, `event`, `status`, `lease` (§5). 표본화는 초당 200건을 넘으면 시작하고, 생략 건수를 `event` 묶음에 담습니다.
- 매니페스트(§6), 인증과 actor 판별(§7), `TESTBED_CONTROL_TOKEN`.
- `bun run testbed:release`: 서버 쪽에서 락을 강제로 푸는 명령. 실행 중인 인스턴스에 로컬(127.0.0.1) 전용 경로로 요청하고, `testbed.lease.released`에 `actor: 'system'`, `reason: 'forced'`를 남깁니다.

**수용 기준** (`bun test`의 HTTP 통합 테스트로 자동화하고, 아래 curl 흐름이 수동으로도 재현됨)

- `GET /testbed/api/manifest` → `cores[0].id == 'sample'`, `endpoints[0].protocol == 'tcp'`, `control.rest == '/testbed/api'`, `instanceId` 있음.
- `POST /testbed/api/lease`(`X-Testbed-Actor: ci`) → `leaseId`. 같은 헤더로 `POST /runs {label:'t1'}` → 201. 헤더 없이(`X-Testbed-Actor: human`) `POST /cores/sample/stop` → 423 `LOCKED`, 본문에 보유자와 남은 시간. 다른 `leaseId`로 `X-Testbed-Actor: ci` 호출 → 409 `LEASE_HELD`. 거절마다 `testbed.lease.denied`.
- 락 보유 중 `GET /status`, `GET /events` 는 누구나 200.
- `TESTBED_LEASE_TTL_SEC=1`로 띄우고 락을 잡은 뒤 2초 기다리면 `testbed.lease.expired`, 이후 사람 조작이 200.
- `POST /cores/sample/actions/broadcast {text:'hi'}`(락 보유자) → 200 `{ sent: n }`, `testbed.control.invoked` 남음.
- `PATCH /cores/sample/config {port: 0}` → 200 `result: 'restart-required'`. `{faults:[{id:'f1', error:'x'}]}` → 400 `VALIDATION_ERROR`.
- `POST /runs`를 두 번 → 두 번째 409 `RUN_ACTIVE`. `{endActive:true}` → 201, `GET /runs/<앞 Run>`의 `endReason == 'replaced'`.
- `GET /events?after=<다른 instanceId>:0` → 410 `CURSOR_STALE`.
- `POST /wait {filter:{kind:'sample.data.echoed'}, count:1, timeoutMs:5000}` 대기 중 TCP로 데이터 전송 → 대기가 1건으로 끝남. 시간이 지나면 지금까지의 결과(0건)를 돌려줌.
- `GET /runs/:id/export` → `Content-Type: application/x-ndjson`, 줄마다 이벤트 하나.
- WS 연결 → 첫 메시지 `snapshot`, TCP 데이터 전송 → `event` 증분, 락 획득 → `lease` 증분.
- `TESTBED_CONTROL_TOKEN=x`로 띄우면 Bearer 없는 에이전트·CI 호출 → 401 `UNAUTHORIZED`, `Authorization: Bearer x` → 정상.
- `bun run testbed:release` → 락 해제, `testbed.lease.released`(`reason: 'forced'`).
- `bun run check` 통과.

### P2·P3 공통 규칙

- P2(M5–M6)와 P3(M7–M10)는 P1이 만든 제어 서비스(`src/server/testbed/control/service.ts`)를 부르는 어댑터와 화면만 추가합니다. **제어 서비스에 없는 동작이 필요하면 먼저 제어 서비스 함수로 추가**하고, 그 함수를 REST·MCP·UI가 함께 씁니다.
- 각 마일스톤의 "같은 PR에서 고칠 문서"는 그 마일스톤이 끝났을 때 `docs/testbed/`가 실제 구현과 일치하도록 고치는 목록입니다.

### M5 — P2-a: 제어면 MCP 어댑터

**범위**

- `/testbed/mcp`에 Streamable HTTP MCP 서버를 붙입니다. 붙이는 방법은 2절 "MCP SDK (M1 결과)"를 따르고, `src/server/testbed/mcp/mcp-sdk.integration.test.ts`를 참조 구현으로 씁니다. 응답은 기본 SSE 방식입니다.
- **세션과 caller**
  - 세션마다 전송과 `McpServer`를 하나씩 만듭니다. caller는 `{ actor: 'agent', sessionId: <Mcp-Session-Id>, name: <clientInfo.name> }`입니다.
  - `DELETE`로 세션이 끝나면 `lease.releaseSession(sessionId)`를 부릅니다.
  - 세션 상한 `TESTBED_MCP_MAX_SESSIONS`(기본 32): 넘으면 새 `initialize`를 HTTP 503과 JSON-RPC 오류로 거절합니다. 오류 문장: "MCP 세션이 상한(32)에 도달함. 쓰지 않는 세션을 닫거나(`DELETE`) 잠시 뒤 다시 시도".
  - 유휴 세션 정리 `TESTBED_MCP_SESSION_IDLE_SEC`(기본 3600): 그 시간 동안 요청이 없는 세션은 서버가 닫습니다. 락을 쥔 세션이면 락도 함께 풀립니다(`reason: 'session-closed'`).
- **인증**
  - `TESTBED_CONTROL_TOKEN`이 있으면 모든 MCP 요청에 `Authorization: Bearer <token>`이 필요합니다. 없거나 틀리면 401입니다.
  - 토큰이 없으면(로컬) 인증 없이 받습니다. MCP 호출자는 언제나 `agent`이고, `X-Testbed-Actor`는 보지 않습니다.
- **`initialize`의 `instructions`** (그대로 씀):
  > 테스트베드 제어면입니다. 처음엔 `testbed_info`로 코어·데이터면 주소·락 상태를 봅니다. 시험은 `start_run` → 제품 작업 → `query_events`/`wait_for`/`check` → `end_run` 순서로 합니다. 조작 도구는 첫 호출 때 제어 락을 잡고, 그동안 사람은 대시보드에서 조작할 수 없습니다. 끝나면 `release_control`을 부릅니다.
- **공통 도구**(아래 표)와 코어 액션 도구를 등록합니다. 모든 도구는 제어 서비스 함수를 부르기만 합니다.
- **액션 자동 노출**: `surfaces`에 `mcp`가 있는 액션마다 `<core>_<action>` 도구를 만듭니다. 코어 id의 `-`는 `_`로 바꿉니다. 설명은 액션의 `description`에 "(제어 락 필요)" 또는 "(읽기 전용)"을 덧붙이고, 입력 스키마는 액션의 `input` 검증기를 씁니다.
- **도구 주석**: 읽기 도구는 `annotations.readOnlyHint: true`를 답니다. 조작 도구는 `false`입니다.
- **결과 형식**
  - 성공: `content`에 사람이 읽는 짧은 텍스트(여러 줄 가능), `structuredContent`에 기계용 객체를 담습니다.
  - 실패: 제어 서비스가 던진 `TestbedError`와 검증 오류는 JSON-RPC 오류가 아니라 도구 결과 `isError: true`로 돌려줍니다. `content`에는 오류 문장(다음 행동을 알려 주는 문장)을, `structuredContent`에는 `{ error: { code, message, details } }`를 담습니다. 예상하지 못한 예외만 JSON-RPC 내부 오류로 둡니다.
- **이벤트 한 줄 형식**(`query_events`, `wait_for`, `check`의 `content`): `<id> <HH:MM:SS.mmm> <level> <kind> <summary>`. 시각은 UTC입니다.

**공통 도구의 입력과 출력**

| 도구                       | 입력                                                                                                   | `structuredContent`                                                                                          | 락  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --- |
| `testbed_info`             | `{}`                                                                                                   | `{ name, version, instanceId, cores:[{id, kind, state, endpoints, actions:[name]}], run, lease }`            | –   |
| `get_config`               | `{ core }`                                                                                             | 설정 객체                                                                                                    | –   |
| `set_config`               | `{ core, patch }`                                                                                      | `{ result: 'applied' \| 'restart-required', config }`                                                        | ●   |
| `start` / `stop` / `reset` | `{ core?: string }` (생략하면 `_all`)                                                                  | `{ cores: CoreStatus[] }`                                                                                    | ●   |
| `start_run`                | `{ label, seed?, configOverrides?, endActive? }`                                                       | `RunMeta`                                                                                                    | ●   |
| `end_run`                  | `{}`                                                                                                   | `RunMeta`(요약 포함)                                                                                         | ●   |
| `query_events`             | 이벤트 필터 전체(`runId`, `core`, `kind`, `level`, `actor`, `correlationId`, `text`, `after`, `limit`) | `{ events: EventLine[], nextCursor, total }` — payload 없음                                                  | –   |
| `get_event`                | `{ id }`                                                                                               | 이벤트 전체                                                                                                  | –   |
| `wait_for`                 | `{ filter, count?: 1, timeoutMs?: 30000 }` (상한 120000)                                               | `{ matched, timedOut, events: EventLine[] }`                                                                 | –   |
| `check`                    | `{ filter, expect, label? }`                                                                           | `{ pass, matched, sample: EventLine[] }`                                                                     | –   |
| `export_run`               | `{ runId?: string }` (생략하면 열린 Run, 없으면 가장 최근에 닫힌 Run)                                  | `{ runId, url, path? }` — `url`은 `TESTBED_PUBLIC_URL` 기준 export 주소, `path`는 file 저장소일 때 파일 경로 | –   |
| `acquire_control`          | `{}`                                                                                                   | `{ expiresAt }`                                                                                              | –   |
| `release_control`          | `{}`                                                                                                   | `{ released }`                                                                                               | –   |

- `EventLine`은 `{ id, ts, level, kind, summary, correlationId? }`입니다.
- `testbed_info`의 `content`는 코어마다 한 줄(`sample running tcp://127.0.0.1:40001 actions: broadcast`)과 열린 Run, 락 보유자를 줄로 씁니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/control-plane.md` §4: 위 표, 결과·오류 형식, 이벤트 한 줄 형식, 세션 상한·유휴 정리, 인증.
- `docs/testbed/architecture.md` §7: `TESTBED_MCP_MAX_SESSIONS`, `TESTBED_MCP_SESSION_IDLE_SEC`.
- `.env.example`: 위 두 변수(주석 포함).

**수용 기준** (`bun test`의 MCP 통합 테스트. SDK 클라이언트로 실제 서버에 붙음)

- `initialize` → `instructions`가 위 문장과 같음. `tools/list`에 공통 도구 15개와 `sample_broadcast`가 있고, 읽기 도구에만 `readOnlyHint: true`.
- `testbed_info` → `structuredContent.cores[0].id == 'sample'`, `endpoints[0].protocol == 'tcp'`.
- `start_run {label:'m5'}` → 락이 이 세션으로 잡힘(`testbed.lease.acquired`, `actor: 'agent'`, `name`이 클라이언트 이름). TCP로 데이터 전송 → `wait_for {filter:{kind:'sample.data.echoed'}}` → `matched: 1`. `check {filter:{kind:'sample.data.echoed'}, expect:{count:'==1'}}` → `pass: true`. `end_run` → 요약에 `sample.data.echoed` 1건.
- 두 번째 세션의 `stop {core:'sample'}` → `isError: true`, `code: 'LEASE_HELD'`, 문장에 보유자와 남은 시간. 두 번째 세션의 `query_events`는 성공.
- 락 보유 중 REST `POST /testbed/api/cores/sample/stop`(사람) → 423.
- 첫 세션 `release_control` → 두 번째 세션의 `stop`이 성공하고 락이 두 번째 세션으로 넘어감.
- 락을 쥔 세션을 `DELETE`로 닫으면 `testbed.lease.released`(`reason: 'session-closed'`).
- `start_run`을 두 번 → 두 번째 `RUN_ACTIVE`, 문장에 `endActive` 안내. `endActive: true` → 성공.
- `query_events {limit: 2}` → 2건과 `nextCursor`. 그 커서로 다시 부르면 이어지는 이벤트. 다른 인스턴스 커서 → `CURSOR_STALE`.
- `get_event {id}` → payload 포함 전체. `query_events` 결과에는 payload가 없음.
- `wait_for {timeoutMs: 200}`(맞는 이벤트 없음) → `timedOut: true`, `matched: 0`. `timeoutMs: 999999` → 120000으로 잘림(검증 오류 아님).
- `export_run` → `url`이 `/testbed/api/runs/<id>/export`로 끝남. `TESTBED_RUN_STORE=file`이면 `path`가 실제 파일을 가리킴.
- `sample_broadcast {text:'hi'}` → `{ sent: n }`. `text: ''` → `isError: true`, `VALIDATION_ERROR`.
- `set_config {core:'sample', patch:{faults:[{id:'f1', error:'x'}]}}` → `isError: true`, `VALIDATION_ERROR`.
- `TESTBED_CONTROL_TOKEN=x` → 토큰 없는 `initialize`는 401, `Authorization: Bearer x`면 성공.
- `TESTBED_MCP_MAX_SESSIONS=1` → 두 번째 `initialize`가 503. `TESTBED_MCP_SESSION_IDLE_SEC=1` → 2초 뒤 그 세션의 호출이 404, 락을 쥐고 있었다면 풀림.
- `bun run check` 통과.

### M6 — P2-b: `bun run testbed:smoke`와 스모크 시나리오

**범위**

- **실행 방식**
  - `bun run testbed:smoke`: 빈 포트로 이 저장소의 서버를 자식 프로세스로 띄우고(`TESTBED_RUN_STORE=memory`, 코어 포트는 모두 `0`), `/api/health/ready`가 200이 되면 시작합니다. 끝나면 서버를 종료합니다.
  - `bun run testbed:smoke --url <base>`: 이미 떠 있는 인스턴스(로컬 또는 Docker 이미지)를 대상으로 합니다. `TESTBED_CONTROL_TOKEN` 환경 변수가 있으면 Bearer로 보냅니다.
  - `--only <이름>`: 시나리오 하나만 실행. `--json <경로>`: 결과를 JSON으로 저장.
  - 종료 코드: 모두 통과(건너뜀 포함) 0, 하나라도 실패 1, 서버를 띄우지 못하거나 연결하지 못함 2.
- **순서**
  1. **공통 점검**(공통 런타임이 제공. 모든 테스트베드에서 같음): 공통 도구 15개를 모두 한 번 이상 부르고, 두 세션 사이의 락 배타성(`LEASE_HELD`), 락 보유 중 사람 REST 조작의 423, `release_control` 뒤 해제를 확인합니다. 끝나면 열린 Run을 닫고 락을 풉니다.
  2. **시나리오**: 아래 위치의 시나리오 파일을 이름순으로 실행합니다. 시나리오마다 새 MCP 세션을 쓰고, 끝나면(실패해도) 열린 Run을 닫고 `release_control` 후 세션을 닫습니다.
  3. **액션 커버리지**: 매니페스트에서 MCP에 노출된 액션이 건너뛰지 않은 시나리오에서 한 번 이상 불렸는지 확인합니다. 안 불린 액션이 있으면 실패입니다.
- **시나리오 파일**
  - 위치: `src/server/testbed/cores/<core id>/smoke/*.smoke.ts`. 테스트베드 레포는 `cores/` 아래에만 추가하므로 공통 런타임을 고치지 않습니다. 여러 코어에 걸친 시나리오는 그 테스트베드의 주 코어 폴더에 둡니다.
  - 형식:

    ```ts
    import { defineSmoke } from '@server/testbed/smoke';

    export default defineSmoke({
      name: 'sample-echo', // 파일 안에서 유일, 결과 보고에 씀
      title: '보낸 바이트가 그대로 돌아오고 이벤트가 남음',
      spec: 'docs/spec.md §11 M3', // 근거가 된 수용 기준
      requires: { cores: ['sample'] }, // 매니페스트에 없으면 건너뜀
      async run(t) {
        await t.call('start_run', { label: 'smoke:sample-echo' });
        const echo = t.tcp(t.endpoint('sample', 'echo'));
        await echo.send('hello');
        t.equal(await echo.receive(5), 'hello');
        await t.expectCheck({ kind: 'sample.data.echoed' }, { count: '==1' });
        await t.call('end_run', {});
      },
    });
    ```

  - 실행 도구 `t`가 주는 것

    | 이름                                              | 하는 일                                                                     |
    | ------------------------------------------------- | --------------------------------------------------------------------------- |
    | `t.call(tool, input)`                             | MCP 도구 호출. `structuredContent`를 돌려줌. `isError`면 시나리오 실패      |
    | `t.callError(tool, input, code)`                  | 오류가 나야 하는 호출. `code`가 다르거나 성공하면 실패                      |
    | `t.newSession()`                                  | 다른 MCP 세션(다른 에이전트 흉내). 같은 `call`·`callError`를 가짐           |
    | `t.rest(method, path, { body?, actor? })`         | REST 호출(사람·CI 흉내). `{ status, body }`를 돌려줌                        |
    | `t.manifest`, `t.endpoint(core, name)`            | 매니페스트와 데이터면 주소                                                  |
    | `t.tcp(url)`                                      | TCP 클라이언트: `send(data)`, `receive(bytes, timeoutMs?)`, `close()`       |
    | `t.expectCheck(filter, expect)`                   | `check` 호출 후 `pass`가 아니면 실패(일치한 이벤트 줄을 실패 메시지에 담음) |
    | `t.waitFor(filter, count?, timeoutMs?)`           | `wait_for` 호출 후 `timedOut`이면 실패                                      |
    | `t.equal(a, b, message?)`, `t.ok(cond, message?)` | 단언                                                                        |

  - 시나리오 하나의 제한 시간은 기본 60초(`timeoutMs`로 바꿈)입니다. 넘으면 실패로 보고 정리 단계로 갑니다.
- **보고**: 시나리오마다 `PASS`/`FAIL`/`SKIP`, 걸린 시간, 실패면 실패한 단계와 메시지를 한 줄씩 씁니다. 마지막에 합계와 커버리지 결과를 씁니다.
- **testbed-base의 시나리오**(샘플 코어, `src/server/testbed/cores/sample/smoke/`)
  - `sample-echo`: 위 예시.
  - `sample-faults`: `set_config`로 `disconnect` 규칙 → 전송하면 연결이 닫힘, `testbed.fault.injected`와 `closed(reason:'fault')` 확인 → `corrupt` 규칙 → 받은 바이트가 XOR `0xFF` → 규칙 비움.
  - `sample-broadcast`: TCP 연결 2개 → `sample_broadcast {text:'hi'}` → 둘 다 `hi` 수신, `sent: 2`.
  - `sample-run-replace`: `start_run` 두 번째 `RUN_ACTIVE` → `endActive: true`로 성공 → 앞 Run의 `endReason == 'replaced'`(REST `GET /runs/:id`).
- **CI**
  - `ci.yml`의 테스트 단계 뒤에 `bun run testbed:smoke`를 추가합니다.
  - 이미지 job: 이미지를 빌드한 뒤 push 전에 컨테이너를 띄우고(`-p 40000:40000`) `bun run testbed:smoke --url http://localhost:40000`이 통과해야 push합니다.
- `knip.json`의 `entry`에 `src/server/testbed/cores/*/smoke/*.smoke.ts`를 추가합니다(동적으로 불러오므로).

**같은 PR에서 고칠 문서**

- `docs/testbed/verification.md`: MCP 스모크 절을 실제 실행 방식·순서·시나리오 형식·보고·종료 코드로 바꿈.
- `docs/testbed/spec-template.md`: 11절 주석에 "M2부터의 수용 기준은 스모크 시나리오(`cores/<id>/smoke/`)로 옮겨 실행할 수 있게 쓴다"를 넣고, 마일스톤 표의 M2·M4 완료 판정을 `bun run testbed:smoke` 기준으로 고침.
- `docs/testbed/core-contract.md` §2 코드 위치: 스모크 시나리오 위치 추가.

**수용 기준**

- `bun run testbed:smoke` → 공통 점검과 시나리오 4개 `PASS`, 커버리지 통과, 종료 코드 0.
- `sample-echo`의 기대값을 일부러 틀리게 바꾸면(시험용 임시 수정) 해당 시나리오 `FAIL`, 실패 단계와 메시지가 보이고 종료 코드 1, 다른 시나리오는 계속 실행됨. 실패한 시나리오가 연 Run과 락은 정리되어 있음.
- `requires: { cores: ['nope'] }`인 시나리오 → `SKIP`, 종료 코드 0.
- `sample-broadcast`를 빼고 실행 → 커버리지 실패(`sample_broadcast`가 안 불림), 종료 코드 1.
- `bun run dev`로 띄운 인스턴스에 `--url` → 같은 결과. 서버가 없는 주소 → 종료 코드 2.
- `--json out.json` → 시나리오별 결과가 담긴 JSON.
- CI 워크플로에 스모크 단계가 있고, 이미지 job에서 컨테이너 대상 스모크가 push보다 먼저 실행됨.
- `bun run check` 통과.

### M7 — P3-a: 대시보드 데이터 계층, 셸, 상태 바, 연결 패널

**범위**

- **스토어**(`src/client/testbed/store/`): React state 밖에 둡니다.
  - `/testbed/ws`에 연결해 `snapshot`으로 상태·이벤트를 채우고, `event`·`status`·`lease` 증분을 반영합니다.
  - 이벤트는 최근 5000건만 둡니다. `event` 묶음의 `omitted`는 누적해서 보여 줄 수 있게 둡니다.
  - 끊기면 1초부터 2배씩 최대 10초 간격으로 다시 연결합니다. 다시 연결되면 새 `snapshot`으로 통째로 바꿉니다. `instanceId`가 바뀌었으면 "테스트베드가 재시작됨" 알림을 한 번 띄웁니다.
  - 컴포넌트는 `useSyncExternalStore`로 구독하고, 스토어는 스냅샷을 최대 10Hz로 내보냅니다(100ms 묶음).
- **REST 호출**: 보일러플레이트 규칙대로 `src/client/api/endpoints.ts`에 모든 `/testbed/api` 엔드포인트를 적고 `http.ts`로 부릅니다. 대시보드의 호출자는 사람입니다(`X-Testbed-Actor`를 보내지 않음).
- **셸**(`/`): 빈 자리 페이지를 없애고 대시보드 셸로 바꿉니다.
  - 영역: 위 상태 바 / 왼쪽 코어 열(코어 카드, M8) / 가운데 주 영역(탭) / 오른쪽 상세 패널(M9).
  - 주 영역 탭: 이벤트 로그, 통계, Run, 에이전트 타임라인(M9), 그리고 코어가 등록한 고유 패널. 선택한 탭은 주소(`?tab=`)에 남깁니다.
  - 화면 폭 1024px 미만에서는 코어 열과 상세 패널을 보일러플레이트의 오버레이(사이드바·바텀시트)로 엽니다.
- **패널 슬롯**: 테스트베드는 셸을 고치지 않고 `src/client/testbed/cores/<core id>/index.ts`에서 등록합니다. 공통 런타임은 `src/client/testbed/cores/index.ts`에서 목록을 모읍니다(서버의 `cores/index.ts`와 같은 방식).

  ```ts
  interface ClientCoreModule {
    core: string;
    panels?: { id: string; title: MessageKey; component: ComponentType }[]; // 주 영역 탭
    configForm?: ComponentType<ConfigFormProps>; // 설정 전용 폼(M8). 없으면 JSON 편집기
  }
  ```

  고유 패널은 스토어 훅(`useTestbedEvents(filter)`, `useTestbedStatus()`, `useLease()`)과 REST 함수만 씁니다.

- **상태 바**: 이름·버전·`instanceId` 앞 8자, 코어별 상태 점(색과 함께 상태 글자를 `aria-label`로), 열린 Run(label과 경과 시간), 연결 상태(연결됨/다시 연결 중).
- **락 표시**: [testbed/dashboard.md](testbed/dashboard.md) §2. `<html data-lease="none|agent|ci">`, 배너 문구 "<이름 또는 actor>가 제어 중 · 세션 <앞 4자> · 남은 시간 mm:ss"(1초마다 갱신). 모든 조작 컨트롤은 `useCanOperate()` 하나로 비활성 여부를 정하고 `aria-disabled="true"`를 답니다.
- **연결 패널**: 데이터면 주소(복사 버튼), 제어면 MCP URL, `.mcp.json` 조각, 제품 레포 CLAUDE.md 스니펫(아래 틀)의 복사 버튼.
  - 매니페스트에 `publicUrl`(`TESTBED_PUBLIC_URL`)을 추가합니다. 주소는 모두 이 값으로 만듭니다.
  - `.mcp.json` 조각: `{ "mcpServers": { "tb-<name에서 'testbed-' 뺀 것>": { "type": "http", "url": "<publicUrl>/testbed/mcp" } } }`. `auth.control == 'bearer'`면 `"headers": { "Authorization": "Bearer ${TESTBED_CONTROL_TOKEN}" }`를 넣습니다.
  - CLAUDE.md 스니펫 틀: 테스트베드 이름·용도 한 줄, MCP 서버 이름, 기본 흐름(`testbed_info` → `start_run` → 작업 → `check` → `end_run` → `release_control`), 데이터면 주소 목록. 테스트베드마다 덧붙일 문장은 매니페스트에 없으므로 이 단계에서는 틀만 둡니다.
- **로그인**: `AUTH_DRIVER=oidc`인데 로그인하지 않았으면(WS 401) 대시보드 대신 "로그인 필요" 안내와 보일러플레이트의 로그인 컨트롤을 보여 줍니다.
- 문구는 모두 i18n(ko/en)에 둡니다. testid는 아래 "대시보드 testid" 표를 따릅니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/dashboard.md`: 스토어, 영역, 패널 슬롯 인터페이스, 연결 패널 조각 형식.
- `docs/testbed/control-plane.md` §6: 매니페스트의 `publicUrl`.
- `docs/ui-automation.md`: 테스트베드 testid 표.

**수용 기준**

- 스토어 단위 테스트(`bun test`, 가짜 WS): `snapshot` 후 `event` 증분이 순서대로 쌓임 / 5000건 초과 시 오래된 것부터 빠짐 / 끊김 후 다시 연결하면 `snapshot`으로 바뀌고 `instanceId`가 다르면 재시작 알림 / 구독자 알림이 100ms에 한 번 이하.
- 클라이언트 코어 등록 테스트: 가짜 모듈 하나를 등록하면 탭 목록에 그 패널이 나옴.
- `.mcp.json` 조각 생성 함수 테스트: `auth.control`이 `none`일 때와 `bearer`일 때.
- 수동: `bun run dev` → `/`에 상태 바(`sample` running), 연결 패널의 주소가 `TESTBED_PUBLIC_URL` 기준. REST로 락을 잡으면(`X-Testbed-Actor: agent`) 배너가 뜨고 `<html data-lease="agent">`. PR에 라이트·다크 화면 캡처를 붙입니다.
- `bun run check` 통과.

### M8 — P3-b: 코어 카드, 편집 잠김 래퍼, 액션 폼, 결함 규칙 편집기

**범위**

- **코어 카드**(코어 열에 코어마다 하나): 제목·유형·상태, 카운터(`status().counters`), start/stop/reset 버튼, 설정 편집, 액션, 결함 규칙. 접었다 펼 수 있습니다.
- **편집 잠김 래퍼**(`LockAwareEditor`): 설정 편집기·액션 폼·결함 규칙 편집기가 모두 이 래퍼를 씁니다. 코어 전용 폼도 같습니다.
  - 편집을 시작한 시점의 서버 값을 기억합니다.
  - 락이 걸리면 입력을 지우지 않고 읽기 전용으로 바꾸고, "<보유자>가 제어를 시작해 저장할 수 없음 · 입력 복사" 안내를 띄웁니다. 복사는 클립보드에 입력 그대로를 넣습니다.
  - 저장이 `423 LOCKED`로 거절돼도 같은 안내를 띄우고 입력을 보존합니다.
  - 락이 풀렸을 때 서버 값이 편집 시작 시점과 다르면 "서버 값이 바뀜 · 다시 불러오기 / 내 입력 유지"를 고르게 합니다. 같으면 바로 편집을 이어 갑니다.
- **설정 편집**: 코어가 `configForm`을 등록하지 않았으면 JSON 편집기(TextArea, 들여쓰기 2칸)를 씁니다. 저장은 `PATCH /cores/:core/config`이고, `VALIDATION_ERROR`의 `details`를 필드 경로와 함께 편집기 아래에 보여 줍니다. 결과가 `restart-required`면 "재시작해야 적용됨 · 지금 재시작" 안내와 버튼(stop → start)을 띄웁니다.
- **액션 폼**: `surfaces`에 `ui`가 있는 액션마다 버튼 하나. 누르면 `inputSchema`로 만든 폼을 엽니다.
  - 지원하는 스키마: `string`(minLength·maxLength·enum), `number`·`integer`(minimum·maximum), `boolean`, 이 셋으로 된 1단계 `object`. 그 밖의 스키마는 JSON 편집기로 대신합니다.
  - 실행 결과(출력 JSON 또는 오류 문장)를 폼 아래에 보여 줍니다. `mutating: false` 액션은 락이 걸려도 실행할 수 있습니다.
- **결함 규칙 편집기**: 코어 설정의 `faults`를 표로 편집합니다. 열: id, match(키=값 목록), probability, delayMs(고정 또는 min–max), 효과(매니페스트의 `faults`에 있는 종류만 고를 수 있음), times. 행 추가·삭제·순서 바꾸기. 저장은 설정 패치(`{ faults: [...] }`)입니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/dashboard.md` §1 코어 카드, §2.1 편집 잠김(래퍼 이름과 동작), 액션 폼이 지원하는 스키마.

**수용 기준**

- 단위 테스트: 스키마 → 폼 필드 변환(지원 타입마다, 미지원 스키마는 JSON 편집기로) / `LockAwareEditor` 상태 전이(편집 중 잠김 → 입력 보존·읽기 전용 → 해제 시 서버 값 같음: 바로 편집 / 다름: 선택 표시 → "다시 불러오기"는 서버 값으로, "내 입력 유지"는 입력 유지) / 결함 규칙 표 ↔ `FaultRule[]` 왕복 변환.
- 수동: 샘플 코어 카드에서 `maxConnections` 변경 저장 → `applied`, `port` 변경 → 재시작 안내. `broadcast` 폼 실행 → `{ sent: n }` 표시. `disconnect` 규칙 추가 저장 → TCP 전송 시 연결이 닫힘.
- `bun run check` 통과.

### M9 — P3-c: 이벤트 로그, 상세 패널, 통계, Run 패널, 에이전트 타임라인

**범위**

- **이벤트 로그**(탭)
  - 가상 스크롤(행 높이 고정, 보이는 행 + 위아래 20행만 그림). 한 행: 시각(로컬 시간 `HH:MM:SS.mmm`), level, actor, kind, summary.
  - 필터: core, kind 접두사, level 이상, actor, Run(현재 / 특정 Run / 전체), summary 검색. 필터는 주소에 남깁니다.
  - 맨 아래에 있으면 새 이벤트를 따라가고, 위로 스크롤하면 따라가기를 멈추고 "새 이벤트 n건 · 맨 아래로" 버튼을 띄웁니다.
  - 생략 건수(`omitted` 누적)를 로그 위에 표시합니다.
  - 지난 Run을 고르면 스토어 대신 REST(`GET /events?runId=…`, 커서로 이어 받기)로 가져옵니다.
- **상세 패널**(오른쪽): 행을 고르면 `GET /events/:id`로 전체를 가져와 봉투 필드와 payload JSON 뷰어(접기·펴기, 경로 복사)를 보여 줍니다. 가린 값(`…(len n, sha256:…)` 형식)은 따로 강조하고 "가린 값" 표시를 붙입니다. `correlationId`가 있으면 같은 묶음의 이벤트 목록(REST로 조회)을 아래에 보여 주고, 누르면 그 이벤트로 이동합니다.
- **통계**(탭): 대상은 현재 Run의 이벤트(없으면 스토어 전체). kind별 건수, level별 건수, 오류율(`error` 건수 / 전체), `latencyMs`가 있는 kind의 평균·p95·최대. 초당 이벤트 수 스파크라인(최근 60초)은 `<canvas>`에 `requestAnimationFrame`으로 직접 그립니다.
- **Run**(탭): 열린 Run(label, 시작 시각, 연 주체, 경과 시간)과 시작·종료 버튼(시작 폼: label, seed, `endActive` 체크), 지난 Run 목록(`GET /runs`), 고르면 요약(기간, kind·level별 건수, 오류 상위, check 결과)과 내보내기 링크. `openedBy`와 `endedBy`가 다르면 "다른 주체가 닫음", `endReason`이 `replaced`·`restart`면 그 사유를 표시합니다.
- **에이전트 타임라인**(탭): actor가 `agent`인 이벤트와 `testbed.control.*`, `testbed.lease.*`만 시간순으로 보여 줍니다. 각 항목에 caller 이름과 세션 앞 4자를 붙입니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/dashboard.md` §1 표의 각 컴포넌트 설명을 실제 동작으로 갱신.

**수용 기준**

- 단위 테스트: 가상 스크롤 범위 계산 / 필터 ↔ 주소 왕복 / 따라가기 멈춤 조건 / 통계 계산(p95를 포함해 고정 입력에 대한 기대값) / 가린 값 감지 / 에이전트 타임라인 필터.
- 성능: 스토어에 초당 2000건을 10초 동안 넣는 테스트(`bun test`, DOM 없이 스토어와 행 계산만)에서 스냅샷 알림이 초당 10회 이하이고, 보이는 행 계산이 한 번에 5ms 이하.
- 수동: TCP 데이터 → 로그에 행 추가, 누르면 상세에 payload, 같은 `connId` 묶음 표시. Run 시작 → 상태 바와 Run 탭에 표시, 종료 → 목록에 요약.
- `bun run check` 통과.

### M10 — P3-d: Playwright UI 자동화

**범위**

- `@playwright/test`를 개발 의존성에 추가하고, 시험은 `e2e/`에 둡니다(`bun test` 대상이 아님). Chromium만 씁니다.
- `bun run test:ui`: 빈 포트로 서버를 띄우고(`TESTBED_RUN_STORE=memory`, 코어 포트 `0`) 시험을 돌린 뒤 종료합니다. 서버를 띄우는 코드는 M6의 스모크와 같은 모듈을 씁니다.
- 시험에서 데이터면·락 조작은 REST와 TCP로 직접 합니다(제품·에이전트 흉내). 선택자는 ARIA 우선, 그다음 `TESTID`([ui-automation.md](ui-automation.md)).
- CI: `ci.yml`에 `bunx playwright install --with-deps chromium`과 `bun run test:ui` 단계를 추가합니다. 실패하면 Playwright 보고서를 아티팩트로 올립니다.
- `knip.json`과 `tsconfig.json`의 `include`에 `e2e`를 추가합니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/verification.md`: UI 자동화 실행 방법과 위치.
- `docs/testbed/spec-template.md`: M3 완료 판정을 `bun run test:ui` 기준으로.

**수용 기준** (`bun run test:ui`의 시험들)

1. **기본 표시**: `/` → 상태 바에 `sample` 상태 `running`, 연결 패널에 TCP 주소.
2. **이벤트 흐름**: TCP로 `hello` 전송 → 이벤트 로그에 `sample.data.echoed` 행 → 누르면 상세 패널에 payload의 `bytes: 5`.
3. **Run**: Run 탭에서 label 입력 후 시작 → 상태 바에 Run 표시 → TCP 전송 → 종료 → 지난 Run 목록에 그 Run, 요약에 `sample.data.echoed` 1건.
4. **락**: 설정 편집기에 입력 중 REST로 락 획득(`X-Testbed-Actor: agent`) → `<html data-lease="agent">`, 배너 표시, start/stop/reset·저장·액션 버튼이 `aria-disabled="true"`, 입력이 그대로이고 읽기 전용. 락 보유자가 REST로 같은 설정을 바꾼 뒤 해제 → "서버 값이 바뀜" 선택이 뜸 → "내 입력 유지" → 입력 유지, 저장 성공.
5. **잠김 중 저장**: 편집 → 저장 직전에 락 획득 → 저장 → 423 안내, 입력 보존.
6. **액션**: `broadcast` 폼에 `hi` → 실행 → 연결해 둔 TCP 클라이언트가 `hi` 수신, 결과 `{ sent: 1 }` 표시.
7. **결함 규칙**: `disconnect` 규칙 추가 → 저장 → TCP 전송 시 연결이 닫히고 로그에 `testbed.fault.injected`.
8. **에이전트 타임라인**: REST로 락 획득·해제(agent) → 타임라인에 `testbed.lease.acquired`·`released`.

- `bun run check`와 `bun run test:ui` 통과.

### 대시보드 testid (M7–M10)

공통 컴포넌트는 `TESTID.testbed.*`입니다. 아래는 시험이 기대는 최소 목록이며, 더 필요하면 같은 규칙(`testbed.<영역>.<요소>`)으로 추가합니다.

| testid                                                                    | 요소                  |
| ------------------------------------------------------------------------- | --------------------- |
| `testbed.status-bar`                                                      | 상태 바               |
| `testbed.status-bar.core(id)`                                             | 코어 상태 점          |
| `testbed.status-bar.run`                                                  | 열린 Run 표시         |
| `testbed.lease-banner`                                                    | 락 배너               |
| `testbed.connection.endpoint(core, name)`                                 | 데이터면 주소         |
| `testbed.connection.copy-mcp-json`                                        | `.mcp.json` 조각 복사 |
| `testbed.tabs.tab(id)`                                                    | 주 영역 탭            |
| `testbed.core-card(id)`                                                   | 코어 카드             |
| `testbed.core-card.start(id)` / `.stop(id)` / `.reset(id)`                | 코어 조작 버튼        |
| `testbed.config-editor(id)` / `.save(id)`                                 | 설정 편집기와 저장    |
| `testbed.editor.locked-notice`                                            | 편집 중 잠김 안내     |
| `testbed.editor.server-changed`                                           | "서버 값이 바뀜" 선택 |
| `testbed.action(core, name)` / `.run(core, name)` / `.result(core, name)` | 액션 버튼·실행·결과   |
| `testbed.faults(id)` / `.add(id)` / `.save(id)`                           | 결함 규칙 편집기      |
| `testbed.event-log` / `.row(eventId)` / `.jump-latest`                    | 이벤트 로그           |
| `testbed.detail` / `.payload`                                             | 상세 패널             |
| `testbed.runs.start` / `.end` / `.item(runId)` / `.summary`               | Run 탭                |
| `testbed.agent-timeline` / `.item(eventId)`                               | 에이전트 타임라인     |

### P4 공통 규칙

- 프로토콜, 감시, 복제, 재현성의 원본은 [testbed/external-core-protocol.md](testbed/external-core-protocol.md)입니다. 이 절은 그 규약을 구현하는 순서와 수용 기준을 정합니다.
- 외부 코어도 제어 서비스에서는 in-proc 코어와 똑같이 보입니다. REST·MCP·대시보드는 외부 코어를 위해 따로 분기하지 않습니다. 복제 지정(`replica`)과 프로세스 정보만 추가로 다룹니다.
- 시험용 외부 코어는 두 가지입니다.
  - **가짜 코어**(M11–M12): `bun`으로 실행하는 TypeScript 스크립트. 환경 변수 `FAKE_MODE`로 일부러 잘못 동작합니다(아래 표). 공통 런타임 시험 전용이며 Python이 없어도 돕니다.
  - **py-echo**(M13–M14): Python 참조 구현의 예제 코어.

  | `FAKE_MODE`         | 동작                                                    |
  | ------------------- | ------------------------------------------------------- |
  | `normal`            | 규약대로 동작. 액션 `echo {text}` → `{ text, replica }` |
  | `crash-after-start` | `start`에 응답한 뒤 종료 코드 3으로 끝남                |
  | `hang-status`       | `status`에 응답하지 않음                                |
  | `bad-stdout`        | 프로토콜이 아닌 줄과 1 MiB를 넘는 줄을 stdout에 씀      |
  | `wrong-kind`        | `initialize`에서 선언과 다른 `kind`를 돌려줌            |
  | `reserved-field`    | 설정 스키마에 `replicas` 필드를 둠                      |
  | `slow-action`       | 액션 응답을 `requestTimeoutMs`보다 늦게 줌              |
  | `ignore-shutdown`   | `shutdown`에 응답하고도 끝나지 않음(SIGTERM도 무시)     |
  | `print-env`         | 받은 환경 변수 이름 목록을 `event` payload로 보냄       |

### M11 — P4-a: 외부 코어 기반(복제 1개)

**범위**

- `defineExternalCore`(protocol §2)와 코어 호스트 연결. 외부 코어는 부팅 때 프로세스를 띄워 `initialize` → 설정 검증 → `applyConfig` → `autoStart`면 `start`.
- JSON Schema → 검증기 변환을 `@shared/validation` 파사드에 추가합니다(`fromJsonSchema`). zod의 기능으로 되면 그것을 쓰고, 안 되면 검증 라이브러리 하나를 추가합니다. 어느 쪽인지 2절에 기록합니다.
- stdio 전송: NDJSON, 한 줄 1 MiB, stdout·stderr 처리, stderr 최근 50줄 보관.
- 요청 전부(`initialize` … `shutdown`)와 알림 전부(`event`, `fault`, `state`, `log`)의 처리.
- 오류 변환(`CORE_ERROR` 502, `CORE_TIMEOUT` 504), `requestTimeoutMs`.
- 환경 변수 전달 규칙(넘기는 것만 넘김).
- 서버 종료 흐름: `stop` → `shutdown` → `shutdownGraceMs` 뒤 SIGTERM → SIGKILL.
- `testbed.core.process.spawned` 이벤트.
- `initialize`가 실패한 코어도 매니페스트에는 나옵니다(선언의 `id`·`kind`·`title`, `state: 'error'`, `detail`에 이유, 액션 없음). `start`를 부르면 프로세스를 다시 띄워 시도합니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/control-plane.md` §3 오류 코드 표: `CORE_ERROR`, `CORE_TIMEOUT`.
- `docs/testbed/events.md` §2.1 예약 kind 표: `testbed.core.process.*`.
- `docs/testbed/core-contract.md`: 외부 코어 선언으로 가는 안내 한 줄.

**수용 기준** (모두 `bun test`, 가짜 코어 사용)

- `normal`: 부팅 후 상태 `running`, `testbed.core.process.spawned`(pid). 매니페스트의 `configSchema`·`actions`가 `initialize` 응답과 같음. `echo {text:'hi'}` → `{ text: 'hi', replica: 'r0' }`. 가짜 코어가 보낸 `event`가 `core`·`replica: 'r0'`가 채워진 봉투로 남음. `fault` 알림 → `testbed.fault.injected`.
- 설정 패치가 `initialize`의 스키마로 검증됨(범위 밖 값 → `VALIDATION_ERROR`).
- `stop` → 상태 `stopped`, 프로세스는 살아 있음(pid 같음). `start` → 다시 `running`, 같은 pid.
- Run을 열고 닫을 때마다 가짜 코어가 `runChanged`를 받고, `seed`가 `<Run seed>:r0`.
- `wrong-kind`·`reserved-field` → 그 코어는 `error`, `detail`에 이유, 다른 코어(`sample`)는 정상.
- `bad-stdout` → 두 줄 모두 버려지고 `warn` 로그, 코어는 계속 `running`.
- `slow-action` → 액션 호출이 `CORE_TIMEOUT`(504), 코어는 계속 `running`.
- 가짜 코어가 `error.data.code: 'OOPS'`로 실패 → `CORE_ERROR`(502), `details.coreCode: 'OOPS'`. `code: 'VALIDATION_ERROR'`면 400 그대로.
- `print-env` → 받은 변수에 `PATH`와 `FAKE_*`가 있고 `TESTBED_CONTROL_TOKEN`이 없음(시험에서 값을 설정해 둔 상태).
- 존재하지 않는 명령 → `error`, `detail`에 `ENOENT`. 매니페스트에 그 코어가 나옴.
- 서버 종료 → 가짜 코어 프로세스가 남지 않음. `ignore-shutdown`이어도 `shutdownGraceMs`×2 안에 SIGKILL로 끝남.
- `bun run check` 통과.

### M12 — P4-b: 감시, 재시작, 복제

**범위**

- 감시 전부(protocol §8): 응답 확인과 `unresponsive`, 비정상 종료와 `exited`(stderr 마지막 20줄), 재시작 백오프, 60초 안정 후 횟수 초기화, `maxRestarts`, `restart: 'never'`, `start`로 다시 띄우기.
- 복제(protocol §6): `replicas` N개, 복제별 seed, 전체 상태·카운터·엔드포인트(`replica` 표시) 합치기, 복제 수 변경은 `restart-required`이고 다음 `stop` → `start`에서 늘리거나 줄임.
- 액션 복제 지정: 제어 서비스 `invokeAction`이 `replica`를 받습니다. REST는 `POST /cores/:core/actions/:name?replica=r1`, MCP는 외부 코어의 액션 도구 입력에 선택 속성 `replica`(문자열)를 덧붙입니다. 모두 보낼 때의 결과 모양은 protocol §6.
- 공유 타입: `CoreStatus`에 `external?: true`와 `replicas?: ReplicaStatus[]`(`{ id, state, detail?, pid?, restarts, lastPingMs?, counters, endpoints }`), `CoreEndpoint`에 `replica?`. 매니페스트의 `replicas`는 설정값, 코어마다 `external` 표시.
- 재시작 백오프의 시작 간격과 안정 시간(60초)은 시험에서 줄일 수 있게 코어 호스트 옵션으로 받습니다. 설정 필드로는 노출하지 않습니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/control-plane.md`: `invokeAction`의 `replica`, REST `?replica`, MCP 액션 도구의 `replica` 속성, 매니페스트의 `external`·`replicas`.
- `docs/testbed/core-contract.md` §3: `CoreStatus.replicas`.

**수용 기준** (모두 `bun test`, 가짜 코어 사용. 시험용으로 `pingIntervalMs: 1000`, `pingTimeoutMs: 200`, 백오프 시작 100ms, 안정 시간 1초)

- `hang-status` → 약 3초 안에 `unresponsive` → `exited` → `restarting`(시도 1, 대기 100ms) → 다시 띄움. `maxRestarts: 2`면 세 번째 실패 후 `error`, `detail: 'restart limit reached'`, 더 띄우지 않음. 그 뒤 `start` → 횟수 0으로 다시 띄움.
- `crash-after-start` → `exited`(종료 코드 3, stderr 마지막 줄 포함) → 재시작 후 다시 `running`이 되었다가 다시 끝남. 백오프 대기가 100 → 200 → 400ms로 늘어남.
- `normal`로 띄운 프로세스를 시험이 직접 kill → 재시작되고, 종료 전 `running`이었으므로 `start`까지 되어 `running`. 1초 안정 후 재시작 횟수가 0.
- `restart: 'never'` + `crash-after-start` → `error`로 남고 다시 띄우지 않음.
- `replicas: 3` → pid가 다른 프로세스 3개, `replicaId` `r0`–`r2`, seed가 `<seed>:r0`…`<seed>:r2`. `status`의 전체 카운터가 복제 합. 하나를 kill하면 그동안 전체 상태가 `running`이 아님(재시작 중 상태), 돌아오면 `running`.
- `echo {text:'a'}`(복제 지정 없음, 3개) → `{ r0: {...}, r1: {...}, r2: {...} }`. `?replica=r1`(REST)·`replica: 'r1'`(MCP) → r1의 출력만. `replica: 'r9'` → `VALIDATION_ERROR`. 복제 하나가 `slow-action`이면 그 자리만 `{ error: { code: 'CORE_TIMEOUT' } }`, 전체는 성공.
- `replicas`를 3 → 1로 패치 → `restart-required`. `stop` → `start` 후 프로세스 1개(r1·r2는 `shutdown`으로 끝남).
- `bun run check` 통과.

### M13 — P4-c: Python 참조 구현과 py-echo

**범위**

- **어댑터** `examples/python-core/testbed_core/`(Python 3.11 이상, 표준 라이브러리만, `asyncio`):
  - stdio NDJSON JSON-RPC 처리, 요청 메서드 전부, 알림 보내기(`emit`, `fault`, `state`, `log`).
  - 코어 작성 틀: 코어가 `kind`, `title`, 설정 스키마(JSON Schema), `default_config(env)`, `faults`, 액션(이름·설명·입출력 스키마·`mutating`·처리 함수), `start`/`stop`/`reset`/`apply_config`/`status`를 정의하면 나머지를 어댑터가 합니다. 공통 필드(`autoStart`, `eventLevel`, `faults`)는 어댑터가 스키마에 넣습니다.
  - `SeededRng`과 `FaultDecider`를 protocol §9 그대로 구현합니다.
  - 처리하지 못한 예외는 JSON-RPC 오류(`data.code: 'INTERNAL'`)로 돌려주고 stderr에 traceback을 씁니다. 프로세스는 끝내지 않습니다.
- **py-echo** `examples/python-core/echo_core.py`와 선언 `examples/python-core/index.ts`(`defineExternalCore`):
  - `passive`. 샘플 코어의 TCP echo와 같은 동작을 줄인 것입니다: 받은 조각을 그대로 돌려보냄, `maxChunkBytes` 초과 시 닫음, 결함 `delay`·`disconnect`·`corrupt`(XOR `0xFF`), 액션 `broadcast {text}` → `{ sent }`.
  - 포트: `port`(env `PY_ECHO_PORT`, 기본 `40002`) + `replicaIndex`. `port`가 `0`이면 모든 복제가 임의 포트. 엔드포인트 이름은 `echo`.
  - 이벤트: `py-echo.connection.opened`, `py-echo.data.echoed`(`latencyMs` 포함), `py-echo.connection.closed`, `py-echo.broadcast.sent`. summary 형식은 샘플 코어(6절)와 같습니다.
  - 설정: `port`(0–65535), `maxChunkBytes`(1–1048576, 기본 65536), 공통 필드. `port` 변경은 `restart-required`.
- **켜는 방법**: 공통 환경 변수 `TESTBED_EXAMPLE_CORES`(쉼표 목록, 기본 빈 값)에 `py-echo`를 넣으면 코어 호스트가 등록합니다. 예제 코어 목록은 공통 런타임이 `examples/`에서 모읍니다. 기본 이미지와 기본 실행에는 들어가지 않습니다.
- **스모크**: 러너가 `examples/*/smoke/*.smoke.ts`도 읽습니다. `examples/python-core/smoke/py-echo.smoke.ts`(`requires: { cores: ['py-echo'] }`): 각 복제 엔드포인트에 echo → `py-echo.data.echoed`가 복제 수만큼(`replica`별 1건) → `py_echo_broadcast` → 결함 `disconnect` 한 번.
- **시험 환경**
  - Python 시험: `examples/python-core/tests/`(`unittest`), `bun run test:python`으로 실행.
  - Bun 통합 시험 중 Python이 필요한 것은 `python3`(3.11 이상)이 없으면 건너뛰고 이유를 출력합니다. `TESTBED_REQUIRE_PYTHON=1`이면 건너뛰지 않고 실패합니다.
  - CI: `actions/setup-python`(3.11) → `bun run test:python` → `TESTBED_REQUIRE_PYTHON=1 bun test` → 기존 스모크에 더해 `TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_REPLICAS=2 bun run testbed:smoke`.
- `tsconfig.json`의 `include`와 `knip.json`의 `entry`·`project`에 `examples/**/*.ts`를 추가합니다.
- `examples/python-core/README.md`: Python으로 외부 코어를 만드는 법(파일 구성, 코어 작성 틀, 선언, 켜는 법, 시험), 테스트베드 이미지에 Python을 넣는 Dockerfile 예시(런타임 단계에 `python3` 설치와 `examples/` 복사).

**같은 PR에서 고칠 문서**

- `docs/testbed/architecture.md` §7: `TESTBED_EXAMPLE_CORES`.
- `docs/testbed/verification.md`: Python 시험과 `TESTBED_REQUIRE_PYTHON`, 예제 코어 스모크.
- `docs/testbed/external-core-protocol.md` §10: 어댑터 사용법 요약과 README 링크.

**수용 기준**

- `bun run test:python` 통과: 어댑터의 메시지 처리, 예외 → `INTERNAL` 오류, 결함 판정, py-echo 단위 동작.
- **언어 간 재현성** (`bun test`, Python 필요): seed 5개(빈 문자열, ASCII, 한글 포함, 64자, `abc:r1`)마다 Bun `SeededRng`과 Python 구현의 처음 1000개 `next()`와 `int(0, 999)` 결과가 같음. 같은 규칙·selector 순서 100개에서 Bun `FaultDecider`와 Python 결정 순서(규칙 id, `delayMs`)가 같음(`probability`·`times`·`delayMs` 범위를 섞은 규칙으로).
- `TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_PORT=0 PY_ECHO_REPLICAS=2`로 띄운 통합 시험: 복제 2개 `running`, 엔드포인트 2개(`replica` 표시). 각 엔드포인트로 보낸 바이트가 그대로 돌아옴. 이벤트에 `replica` `r0`·`r1`. `disconnect` 규칙 → 연결이 닫히고 `testbed.fault.injected`. `py-echo` 프로세스를 kill → 재시작되어 다시 echo 됨.
- 같은 Run seed로 `probability: 0.5` 규칙을 둔 채 py-echo에 같은 순서로 20번 보내기를 두 번 하면 두 번의 결함 적용 순서가 같음.
- `TESTBED_EXAMPLE_CORES`가 비어 있으면 매니페스트에 `py-echo`가 없고 py-echo 스모크는 `SKIP`.
- CI 워크플로에 Python 단계와 예제 코어 스모크가 있음.
- `bun run check` 통과.

### M14 — P4-d: 표면 반영(MCP, REST, 대시보드)

**범위**

- **이벤트 필터 `replica`**: 제어 서비스 필터에 추가하고 REST `GET /events?replica=`, MCP `query_events`·`wait_for`·`check`, 대시보드 이벤트 로그 필터에 반영합니다.
- **코어 로그**: 제어 서비스 `getCoreLog(core, replica?)` → 복제마다 stderr 최근 50줄(가림 적용). REST `GET /testbed/api/cores/:core/log?replica=`, MCP 공통 도구 `get_core_log {core, replica?}`(읽기 전용). in-proc 코어는 빈 목록과 "in-proc 코어는 프로세스 로그가 없음" 문장을 돌려줍니다.
- **`testbed_info`**: 외부 코어 줄에 복제 수와 복제별 상태를 덧붙입니다(`py-echo running x2 (r0 running pid 123, r1 running pid 124)`).
- **대시보드**
  - 코어 카드: 외부 코어면 "외부 프로세스" 표시와 복제 표(id, 상태, pid, 재시작 횟수, 마지막 응답 ms, 엔드포인트). 행을 펼치면 stderr 최근 50줄(`get_core_log`와 같은 REST).
  - 액션 폼: 외부 코어면 대상 선택(전체 / r0 / r1 …). 결과가 복제별이면 복제별로 나눠 보여 줌.
  - 이벤트 로그: `replica` 열(값이 있을 때만)과 필터.
  - 상태 바의 코어 점은 전체 상태를 쓰고, `aria-label`에 복제 수를 덧붙임.
- **testid**: `testbed.core-card.replicas(id)`, `testbed.core-card.replica(id, replicaId)`, `testbed.core-card.replica-log(id, replicaId)`, `testbed.action.target(core, name)`, `testbed.event-log.filter.replica`.
- **UI 자동화 9번**(Python 필요, CI에서는 필수): `TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_REPLICAS=2`로 띄운 대시보드 → 코어 카드에 복제 2행 `running` → 시험이 r1 프로세스를 kill → r1 행이 `running`이 아닌 상태를 거쳐 다시 `running`, 재시작 횟수 1 → r1 행을 펼치면 로그가 보임 → 액션 폼 대상 `r0`로 `broadcast` → 결과에 r0만.
- `bun run test:ui`는 Python이 없으면 9번을 건너뛰고, `TESTBED_REQUIRE_PYTHON=1`이면 실패합니다. CI의 UI 자동화 단계는 `TESTBED_REQUIRE_PYTHON=1`로 돌립니다.

**같은 PR에서 고칠 문서**

- `docs/testbed/control-plane.md`: 필터 `replica`, `getCoreLog`, REST 경로, 공통 도구 16개 표.
- `docs/testbed/dashboard.md`: 코어 카드의 복제 표와 로그, 액션 대상 선택.
- `docs/ui-automation.md`: 위 testid.
- `docs/testbed/verification.md`: 공통 점검이 부르는 도구 수(16개).

**수용 기준**

- MCP 통합 시험: `tools/list`에 공통 도구 16개. `get_core_log {core:'sample'}` → 빈 목록과 안내 문장. 가짜 코어에서 stderr에 쓴 줄이 `get_core_log`에 나오고, 비밀값 형태(`Authorization: Bearer …`)는 가려짐. `query_events {replica:'r1'}` → r1 이벤트만.
- REST 통합 시험: `GET /events?replica=r0`, `GET /cores/:core/log?replica=r0`.
- 스모크 공통 점검이 16개 도구를 모두 부름(`bun run testbed:smoke` 통과).
- `bun run test:ui` 1–9번 통과(CI에서 9번 포함).
- `bun run check` 통과.

## 12. 범위 밖

- 원격 워커와 docker compose 코어(WS 전송 `/testbed/workers`) (P5 — 첫 클라우드 부하 테스트베드가 생길 때)
- 기본 Docker 이미지에 Python을 넣는 것(외부 코어를 쓰는 테스트베드가 자기 Dockerfile에서 넣음. 방법은 M13의 README)
- Python 외 언어의 참조 어댑터
- 복제 하나만 골라 다시 시작하는 조작(감시의 자동 재시작과 코어 단위 `stop`·`start`만 둠)
- `active`·`scenario` 유형의 공통 지원(단계 실행기 등) — 첫 active·scenario 테스트베드가 생길 때
- `docs/agent-usage.md` — 각 테스트베드 레포의 M4 산출물
- 대시보드에서 제어 락을 잡거나 강제로 푸는 기능(설계상 두지 않음)

## 13. 사람에게 확인할 결정

1. **GHCR 이미지 공개 여부** — 저장소는 공개입니다. 이미지 패키지도 공개로 둘지, 비공개로 두고 pull에 토큰을 쓰게 할지.
