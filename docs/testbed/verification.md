# 검증

마일스톤은 그 마일스톤의 수용 기준을 모두 확인한 뒤에 끝냅니다.

## 1. 단계

| 단계       | 도구                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 정적·단위  | `bun run check` (prettier → eslint → tsc → knip → test. CI와 같음)                                                        |
| 통합       | `bun test` — 코어를 in-memory 인스턴스로 띄워 실제 소켓으로 데이터면을 시험                                               |
| MCP 스모크 | `bun run testbed:smoke` — 인스턴스를 띄우고 MCP 클라이언트로 공통 점검, 스펙 수용 기준 시나리오, 액션 커버리지를 실행(§4) |
| UI 자동화  | Playwright + `TESTID` — 핵심 흐름과 락 상태(조작 비활성)                                                                  |
| 자기 사용  | 구현한 에이전트가 자기 `.mcp.json`에 테스트베드를 붙여 수용 기준을 직접 호출해 봄(권장)                                   |

## 2. 마일스톤별 완료 판정

| M   | 판정                                                                            |
| --- | ------------------------------------------------------------------------------- |
| M1  | 코어 단위·통합 테스트 통과, `bun run check` 통과                                |
| M2  | `bun run testbed:smoke` 통과(커버리지 포함)                                     |
| M3  | testid 기반 UI 자동화(핵심 흐름과 락 상태) 통과                                 |
| M4  | 이미지를 띄운 뒤 `bun run testbed:smoke --url` 통과, `docs/agent-usage.md` 존재 |

## 3. 통합 테스트 규칙

- 데이터면 시험은 실제 소켓을 씁니다. 포트는 `0`(임의 포트)으로 열고, `status().endpoints`에서 실제 주소를 읽습니다. 고정 포트에 기대지 않습니다.
- 무작위가 끼는 시험은 seed를 고정합니다.
- 시간에 기대는 시험은 이벤트를 기다립니다(`waitFor`). `sleep`으로 기다리지 않습니다.
- 결함 주입은 종류마다 하나 이상의 시험을 둡니다.

## 4. MCP 스모크 — `bun run testbed:smoke`

구현은 `src/server/testbed/smoke/`(실행기), `scripts/testbed-smoke.ts`(명령)입니다.

### 4.1 실행 방식

| 명령                                 | 대상                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run testbed:smoke`              | 빈 포트로 이 저장소의 서버를 자식 프로세스로 띄웁니다(`TESTBED_RUN_STORE=memory`, 코어 포트 `<CORE_ID>_PORT`는 모두 `0`). `/api/health/ready`가 200이 되면 시작하고, 끝나면 종료합니다. |
| `bun run testbed:smoke --url <base>` | 이미 떠 있는 인스턴스(로컬 `bun run dev` 또는 Docker 컨테이너). 시나리오는 이 체크아웃의 파일을 씁니다.                                                                                 |
| `--only <이름>`                      | 시나리오 하나만. 공통 점검은 그대로 돌고, 액션 커버리지는 `SKIP`입니다.                                                                                                                 |
| `--json <경로>`                      | 결과(공통 점검, 시나리오별 결과, 커버리지, `exitCode`)를 JSON으로 저장                                                                                                                  |

- `TESTBED_CONTROL_TOKEN` 환경 변수가 있으면 MCP와 에이전트·CI REST 호출에 Bearer로 보냅니다.
- 종료 코드: 모두 통과(건너뜀 포함) `0`, 하나라도 실패(커버리지 포함) `1`, 서버를 띄우지 못하거나 연결하지 못함 `2`.
- Docker 컨테이너를 대상으로 할 때는 데이터면 포트까지 열어야 합니다. 포트 블록 전체를 엽니다(예: `-p 40000-40009:40000-40009`, [ports.md](ports.md)).

### 4.2 순서

1. **공통 점검**(`common`, 모든 테스트베드에서 같음): 공통 도구 15개를 모두 한 번 이상 부르고, 두 세션 사이의 락 배타성(`LEASE_HELD`), 락 보유 중 사람 REST 조작의 423, `release_control` 뒤 해제를 확인합니다. 코어를 stop → start → reset 하므로 포트 `0`으로 연 데이터면은 새 포트가 됩니다.
2. **시나리오**: `src/server/testbed/cores/*/smoke/*.smoke.ts`를 시나리오 이름순으로 실행합니다. 시나리오마다 매니페스트를 새로 읽고(데이터면 주소가 바뀌었을 수 있음) 새 MCP 세션을 씁니다.
3. **액션 커버리지**: 매니페스트에서 MCP에 노출된 액션(`<core>_<action>`)이 건너뛰지 않은 시나리오에서 한 번 이상 불렸는지(`t.call`·`t.callError`) 확인합니다. 안 불린 액션이 있으면 실패입니다.

- 각 시나리오(공통 점검 포함)가 끝나면 통과·실패와 관계없이 정리합니다: 열린 Run이 있으면 그 시나리오의 세션으로 `end_run`, 모든 세션 `release_control` 후 세션 종료(`DELETE`), 연 TCP 연결 닫기.
- 시나리오 하나의 제한 시간은 기본 60초(`timeoutMs`로 바꿈)입니다. 넘으면 그때의 단계로 `FAIL`을 보고하고 정리 단계로 갑니다.

### 4.3 시나리오 형식

```ts
import { defineSmoke } from '@server/testbed/smoke';

export default defineSmoke({
  name: 'sample-echo', // 모든 시나리오에서 유일. 보고와 --only에 씀
  title: '보낸 바이트가 그대로 돌아오고 이벤트가 남음',
  spec: 'docs/spec.md §11 M3', // 근거가 된 수용 기준
  requires: { cores: ['sample'] }, // 매니페스트에 없으면 SKIP
  async run(t) {
    await t.call('start_run', { label: 'smoke:sample-echo' });
    const echo = await t.tcp(t.endpoint('sample', 'echo'));
    echo.send('hello');
    t.equal(await echo.receive(5), 'hello');
    await t.expectCheck({ kind: 'sample.data.echoed' }, { count: '==1' });
    await t.call('end_run', {});
  },
});
```

| `t`의 것                                          | 하는 일                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `t.call(tool, input)`                             | MCP 도구 호출. `structuredContent`를 돌려줌. `isError`면 실패                                                           |
| `t.callError(tool, input, code)`                  | 오류가 나야 하는 호출. 오류 `{ code, message, details }`를 돌려줌. `code`가 다르거나 성공하면 실패                      |
| `await t.newSession(name?)`                       | 다른 MCP 세션(다른 에이전트 흉내). 같은 `call`·`callError`를 가짐                                                       |
| `t.rest(method, path, { body?, actor?, lease? })` | `/testbed/api` 아래 REST 호출. `actor`가 없으면 사람, `agent`·`ci`면 그 actor(토큰이 있으면 Bearer). `{ status, body }` |
| `t.manifest`, `t.endpoint(core, name)`            | 매니페스트와 데이터면 주소                                                                                              |
| `await t.tcp(url)`                                | TCP 클라이언트: `send(data)`, `receive(bytes, timeoutMs?)`(UTF-8), `receiveBytes(...)`, `closed(timeoutMs?)`, `close()` |
| `t.expectCheck(filter, expect)`                   | `check` 후 `pass`가 아니면 실패(일치한 이벤트 줄을 실패 메시지에 담음)                                                  |
| `t.waitFor(filter, count?, timeoutMs?)`           | `wait_for` 후 `timedOut`이면 실패. `after` 없이 부르면 부른 뒤의 이벤트만 셈                                            |
| `t.equal(a, b, message?)`, `t.ok(cond, message?)` | 단언(`equal`은 깊은 비교)                                                                                               |

- 시나리오 파일은 `bun test` 대상이 아니고(`*.smoke.ts`), `knip.json`의 `entry`에 들어 있습니다(동적으로 불러오므로).
- 데이터면 동작이 이벤트를 남긴 뒤 응답하는 경우(예: 샘플 코어의 echo·close)에는 응답을 받은 뒤 바로 `t.expectCheck`로 셀 수 있습니다. 그렇지 않으면 커서(`after`)를 잡아 두고 `t.waitFor`로 기다립니다.

### 4.4 보고

시나리오마다 한 줄, 마지막에 커버리지와 합계를 씁니다.

```
PASS common (216ms)
PASS sample-broadcast (154ms)
FAIL sample-echo (12ms) at equal (echoed bytes): expected "HELLO", got "hello"
SKIP needs-nope (0ms) — requires core nope
PASS coverage (sample_broadcast)
total: 3 pass, 1 fail, 1 skip; coverage PASS
```

### 4.5 CI

- `ci.yml`의 `ci` job: 테스트 단계 뒤에 `bun run testbed:smoke`.
- 이미지 job(`main` push만): 이미지를 빌드하고(`load`), 컨테이너를 띄워(`-p 40000-40009:40000-40009`) `bun run testbed:smoke --url http://localhost:40000`이 통과해야 GHCR에 push합니다. 테스트베드 레포는 `IMAGE`와 포트 블록만 바꿉니다.
