# Run과 check

## 1. Run

**Run**은 "에이전트나 사람이 무언가를 시험한 구간"입니다. 에이전트가 "내 변경 뒤에 무슨 일이 있었나"를 정확히 잘라 보는 단위입니다.

### 1.1 시작

```ts
startRun({ label: string, seed?: string, configOverrides?: Record<coreId, Partial<Config>>, endActive?: boolean })
  → { runId, seed, startedAt }
```

- `runId`는 `run-<인스턴스 안 순번>-<짧은 무작위>` 형식입니다. 예: `run-7-k3f9`.
- 시작할 때 **설정 스냅샷**(모든 코어의 현재 설정, `configOverrides` 적용 후)과 **seed**를 Run 메타에 기록합니다. seed를 주지 않으면 생성해서 기록합니다([faults-and-seed.md](faults-and-seed.md)).
- `configOverrides`는 Run이 열려 있는 동안만 적용됩니다. Run이 닫히면 Run 직전 설정으로 돌아갑니다.
- 락이 필요합니다([control-plane.md](control-plane.md)).

### 1.2 열린 Run은 하나

- 인스턴스마다 **동시에 열린 Run은 하나**입니다.
- 이미 열려 있으면 `RUN_ACTIVE` 오류를 내고, 그 Run의 정보(id, label, 연 주체, 시작 시각)를 `details`에 담습니다.
  - 오류 문장 예: "Run이 이미 열려 있음(run-7-k3f9, 'gw-retry', human이 14:02에 엶). 닫고 새로 시작하려면 `start_run`에 `endActive: true`".
- `endActive: true`를 주면 열린 Run을 닫고(`endReason: 'replaced'`) 새 Run을 시작합니다. 누가 연 Run이든 닫을 수 있습니다.

### 1.3 종료

```ts
endRun() → RunSummary
```

- 누가 연 Run이든 닫을 수 있습니다. 락이 필요합니다.
- 요약에 담는 것: 기간, kind·level별 건수, 오류 상위 항목(kind별 상위 5개와 대표 summary), check 결과 목록, scenario 판정.

### 1.4 Run 메타

| 필드                   | 뜻                                       |
| ---------------------- | ---------------------------------------- |
| `runId`, `label`       | 식별과 이름                              |
| `instanceId`           | 이 Run이 열린 부팅                       |
| `seed`                 | 이 Run의 seed                            |
| `configSnapshot`       | 시작 시점의 모든 코어 설정               |
| `openedBy`             | 연 주체(`caller`)                        |
| `endedBy`              | 닫은 주체(`caller`). 열려 있으면 없음    |
| `endReason`            | `'ended'` \| `'replaced'` \| `'restart'` |
| `startedAt`, `endedAt` | UTC ISO 시각                             |
| `summary`              | 닫힐 때의 요약                           |

- 대시보드 Run 패널은 `openedBy`와 `endedBy`가 다르면 "다른 주체가 닫음"을 표시합니다.

### 1.5 Run 밖의 이벤트

- Run 밖의 이벤트(`runId: null`)는 링버퍼에만 남고 Run 저장소에는 들어가지 않습니다.
- 대시보드 기본 화면은 "현재 Run, 없으면 전체"입니다.

## 2. check (판정)

```ts
check({ filter: EventFilter, expect: { count?: '==n' | '>=n' | '<=n', none?: true }, label?: string })
  → { pass: boolean, matched: number, sample: EventLine[] }
```

- `filter`는 `query_events`와 같은 필터입니다([control-plane.md](control-plane.md)). `runId`를 생략하면 열린 Run, 없으면 링버퍼 전체가 대상입니다.
- `count`와 `none` 중 하나만 줍니다. 둘 다 없으면 `'>=1'`로 봅니다.
- 결과로 pass/fail, 일치 건수, 일치한 이벤트 일부(최대 10건)를 payload 없는 한 줄(`EventLine`: `id`, `ts`, `level`, `kind`, `summary`, `correlationId?`)로 돌려줍니다.
- 판정할 때마다 `testbed.check.evaluated` 이벤트가 남고, 열린 Run의 요약에 모입니다.
- check는 조작이 아니므로 락이 필요 없습니다.
- 시나리오 코어도 내부적으로 같은 판정 함수를 씁니다.
