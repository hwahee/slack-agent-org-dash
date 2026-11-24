# testbed-base 스펙

`testbed-base` 자체를 만드는 단계별 스펙입니다. 지금은 P0–P1을 다룹니다. 공통 규약은 [docs/testbed/](testbed/README.md)가 원본이고, 이 문서는 그 규약을 **이 저장소에 처음 구현하는 순서와 수용 기준**을 정합니다.

## 변경 이력

| 날짜       | 바뀐 절          | 영향받는 마일스톤 |
| ---------- | ---------------- | ----------------- |
| 2026-11-24 | 최초 작성(P0–P1) | M0–M4             |

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

## 3. 구성

| 코어 id  | 유형      | 실행    | 복제 | 데이터면                    |
| -------- | --------- | ------- | ---- | --------------------------- |
| `sample` | `passive` | in-proc | 1    | TCP `40001` (`SAMPLE_PORT`) |

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

- MCP와 UI 노출은 각각 P2, P3에서 자동 노출로 생깁니다. 이 스펙에서는 REST만 확인합니다.

## 10. 대시보드

P1 범위 밖입니다. M0에서 `/`는 빈 자리 페이지만 둡니다(`TESTID.testbed.placeholder`). 셸과 공통 컴포넌트는 P3에서 만듭니다.

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

**수용 기준**

- `bun run check` 통과.
- `git grep -n -i -E 'todo-service|todos-page|chat-gateway|chat-service|home-chat|chat-room|presence' -- src scripts` 결과가 비어 있음. `src/client/chat/`, `src/server/presence/`, `src/server/realtime/` 폴더가 없음.
- `.env` 없이 `bun run dev` → `curl -s localhost:40000/` 가 200이고, 빈 자리 페이지의 testid가 들어 있음.
- `docker build` 성공, 컨테이너를 띄우면 `40000`에서 200.
- 워크플로 파일에 이미지 job이 있고 `if: github.ref == 'refs/heads/main'` 조건이 붙어 있음.

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

## 12. 범위 밖

- 제어면 MCP 어댑터와 `bun run testbed:smoke` (P2)
- 대시보드 셸, 공통 컴포넌트, 패널 슬롯, Playwright UI 자동화 (P3)
- 외부 프로세스 코어, 복제, 감시, Python 참조 구현 (P4)
- 원격 워커 (P5)
- `active`·`scenario` 유형의 공통 지원(단계 실행기 등) — 첫 active·scenario 테스트베드가 생길 때
- `docs/agent-usage.md` — 각 테스트베드 레포의 M4 산출물

## 13. 사람에게 확인할 결정

1. **M1이 실패했을 때의 대안** — 제어면 MCP를 직접 구현할지(Streamable HTTP를 SDK 없이), Node 런타임 어댑터를 따로 둘지. M1 결과를 보고 정합니다.
2. **GHCR 이미지 공개 여부** — 저장소는 공개입니다. 이미지 패키지도 공개로 둘지, 비공개로 두고 pull에 토큰을 쓰게 할지.
