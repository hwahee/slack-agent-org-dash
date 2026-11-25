# Python 외부 코어 (`py-echo`와 `testbed_core`)

코어를 Python으로 만드는 참조 구현입니다. 프로토콜은
[docs/testbed/external-core-protocol.md](../../docs/testbed/external-core-protocol.md)이고, 여기의 어댑터가 그것을
대신 처리합니다. Python 3.11 이상, 표준 라이브러리만(`asyncio`) 씁니다.

## 파일 구성

| 파일                      | 내용                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `testbed_core/adapter.py` | 어댑터: stdio NDJSON JSON-RPC, 요청 처리, 알림, 공통 필드, 오류 변환            |
| `testbed_core/rng.py`     | `SeededRng` (Bun과 같은 sfc32, 프로토콜 §9)                                     |
| `testbed_core/faults.py`  | `FaultDecider` (Bun과 같은 판정 순서, 프로토콜 §9)                              |
| `echo_core.py`            | 예제 코어 `py-echo`: TCP echo, 결함 `delay`·`disconnect`·`corrupt`, `broadcast` |
| `index.ts`                | 선언(`defineExternalCore`): glue가 프로세스를 띄울 때 필요한 것만               |
| `smoke/py-echo.smoke.ts`  | MCP 스모크 시나리오                                                             |
| `tests/`                  | Python 단위 시험(`unittest`)                                                    |
| `*.integration.test.ts`   | Bun 시험: 언어 간 재현성, py-echo 통합(Python이 없으면 건너뜀)                  |

## 코어 작성 틀

`Core`를 상속해 아래를 정하고 `run(MyCore())`를 부르면 나머지는 어댑터가 합니다.

```python
from testbed_core import Action, Context, Core, CoreError, run


class Counter(Core):
    kind = "passive"            # 선언의 kind와 같아야 함
    title = "Counter"
    faults = ["error"]          # 적용하는 결함 종류
    config_schema = {           # 자기 필드만. autoStart·eventLevel·faults는 어댑터가 넣음
        "type": "object",
        "properties": {"step": {"type": "integer", "minimum": 1}},
        "required": ["step"],
    }

    def __init__(self) -> None:
        self.value = 0
        self.actions = {
            "bump": Action(
                title="Bump",
                description="value를 step만큼 올리고 새 값을 돌려줌",
                input_schema={"type": "object", "properties": {}},
                output_schema={"type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"]},
                handler=self.bump,
                mutating=True,
            )
        }

    def default_config(self, env):  # 부팅 기본값. <CORE_ID>_* 환경 변수만 보임
        return {"step": int(env.get("COUNTER_STEP", "1"))}

    async def bump(self, ctx: Context, input, caller):
        decision = ctx.decide({"op": "bump"})   # 적용하면 fault 알림까지 어댑터가 보냄
        if decision and decision.get("error"):
            raise CoreError("BUMP_FAILED", decision["error"])   # glue에서는 CORE_ERROR(502)
        self.value += ctx.config["step"]
        ctx.emit("counter.bumped", f"bumped to {self.value}", {"value": self.value}, actor=caller.get("actor"))
        return {"value": self.value}

    async def start(self): ...
    async def stop(self): ...
    async def reset(self):
        self.value = 0

    async def apply_config(self, config):      # running일 때만 불림
        return "applied"                       # 다음 start에 적용되면 "restart-required"

    def status(self):
        return {"endpoints": [], "counters": {"value": self.value}}


if __name__ == "__main__":
    run(Counter())
```

- `self.ctx`(`Context`): `emit(kind, summary, payload, level=, correlation_id=, latency_ms=, actor=)`(`kind`는
  `<core id>.`로 시작, `summary`는 반드시), `state(state, detail)`, `log(msg, level)`, `decide(selector,
correlation_id)`, `rng`(`SeededRng`, 모든 무작위는 이것으로), `config`, `replica_id`·`replica_index`·`replicas`,
  `run_id`, `env`.
- stdout은 프로토콜 전용입니다. `print`는 stderr로(`print(..., file=sys.stderr)`) 하거나 `ctx.log`를 씁니다.
  어댑터는 `initialize` 때 stderr에 한 줄(`testbed_core: <core> <replica> initialized (Python …, protocol 1)`)을 씁니다.
  stderr 최근 50줄은 `get_core_log`와 대시보드 복제 표에서 볼 수 있고, 마지막 줄들은 프로세스가 비정상 종료하면 `testbed.core.process.exited` 이벤트에 남습니다(비밀값은 가림).
- 처리하지 못한 예외는 JSON-RPC 오류(`data.code: 'INTERNAL'`)가 되고 traceback은 stderr로 갑니다. 프로세스는
  끝나지 않습니다. 제어면 코드(`VALIDATION_ERROR`, `CORE_NOT_RUNNING` 등)로 `CoreError`를 던지면 그 코드와 HTTP
  상태가 그대로 쓰입니다.
- seed는 `initialize`와 `runChanged`마다 새로 받고(복제마다 `<seed>:<replicaId>`), 그때마다 어댑터가 `rng`를 새로
  만들고 결함 횟수를 0으로 합니다. 같은 Run seed면 같은 결과입니다.
- 액션 입력의 최상위 속성 `replica`는 예약되어 있어 쓸 수 없습니다.

## 선언

```ts
// src/server/testbed/cores/counter/index.ts (테스트베드 레포의 cores/ 아래)
import { defineExternalCore } from '../../external/define';

export const counterCore = defineExternalCore({
  id: 'counter',
  kind: 'passive',
  title: 'Counter',
  command: ['python3', '-u', 'src/server/testbed/cores/counter/counter.py'],
  // 어댑터를 공통 런타임의 예제에서 가져다 씀
  env: { PYTHONPATH: 'examples/python-core' },
});
```

그리고 `src/server/testbed/cores/index.ts`의 `CORES`에 넣습니다. 명령은 서버의 작업 디렉터리(저장소 루트, 이미지에서는
`/app/dist`)에서 실행됩니다. 프로세스에는 `PATH`, `HOME`, `LANG`, `TZ`, `<CORE_ID>_*`, 선언의 `env`만 전달됩니다.
glue가 붙이는 설정 필드(`replicas`, `restart`, `maxRestarts` 등)와 환경 변수(`<CORE_ID>_REPLICAS` 등)는 프로토콜
§2.1입니다.

## py-echo 켜기

```bash
TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_REPLICAS=2 bun run dev
```

| 변수                      | 기본        | 설명                                                       |
| ------------------------- | ----------- | ---------------------------------------------------------- |
| `TESTBED_EXAMPLE_CORES`   | (비움)      | `py-echo`를 넣으면 등록. 비우면 매니페스트에 없음          |
| `PY_ECHO_PORT`            | `40002`     | 복제 `rN`은 `PY_ECHO_PORT + N`. `0`이면 복제마다 임의 포트 |
| `PY_ECHO_REPLICAS`        | `1`         | 복제 수(1–7, 포트 40002–40008)                             |
| `PY_ECHO_MAX_CHUNK_BYTES` | `65536`     | 이 크기를 넘는 조각을 받으면 연결을 닫음                   |
| `PY_ECHO_BIND_HOST`       | `127.0.0.1` | 데이터면 바인딩. 컨테이너에서는 `0.0.0.0`                  |
| `PY_ECHO_PUBLIC_HOST`     | `localhost` | 엔드포인트 주소(`tcp://<host>:<port>`)에 쓰는 호스트       |

외부 코어에는 `TESTBED_BIND_HOST`가 전달되지 않으므로(프로토콜 §2) 바인딩 주소는 `PY_ECHO_BIND_HOST`로 따로 줍니다.

## 시험

```bash
bun run test:python
```

```bash
bun test examples
```

```bash
TESTBED_EXAMPLE_CORES=py-echo PY_ECHO_REPLICAS=2 bun run testbed:smoke
```

- `bun run test:python`: 어댑터의 메시지 처리, 예외 → `INTERNAL`, 결함 판정, py-echo 단위 동작.
- `bun test`의 Python 시험(언어 간 재현성, py-echo 통합)은 `python3`(3.11 이상)이 없으면 건너뜁니다.
  `TESTBED_REQUIRE_PYTHON=1`이면 실패합니다(CI).

## 테스트베드 이미지에 Python 넣기

기본 이미지에는 Python이 없습니다. 외부 코어를 쓰는 테스트베드는 자기 `Dockerfile`의 런타임 단계에 `python3`를
설치하고 `examples/`(와 자기 코어의 Python 파일)를 서버 작업 디렉터리 아래로 복사합니다.

```dockerfile
FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV APP_ENV=production
ENV PORT=40000
ENV TESTBED_BIND_HOST=0.0.0.0

# Python 외부 코어: python3(Debian bookworm은 3.11)과 코어 파일
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# 명령은 작업 디렉터리(/app/dist) 기준이므로 그 아래에 둠
COPY --from=build /app/examples ./dist/examples

# py-echo를 켜는 경우
ENV TESTBED_EXAMPLE_CORES=py-echo
ENV PY_ECHO_BIND_HOST=0.0.0.0

EXPOSE 40000 40001 40002
WORKDIR /app/dist
CMD ["bun", "index.js"]
```
