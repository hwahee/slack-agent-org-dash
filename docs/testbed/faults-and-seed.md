# 결함 주입과 재현성

## 1. 공통 결함 주입 모델

```ts
interface FaultRule {
  id: string;
  match?: Record<string, unknown>; // 코어별 선택자 (예: { tool: 'echo' }, { path: '/v1/chat/completions' })
  probability?: number; // 0..1, 기본 1
  delayMs?: number | { min: number; max: number };
  error?: string; // 코어가 선언한 오류 종류 (예: 'http-500', 'rpc-error', 'rate-limit')
  disconnect?: boolean;
  corrupt?: boolean; // 잘못된 형식의 응답
  times?: number; // n번 적용한 뒤 비활성
}
```

- 코어 설정의 `faults: FaultRule[]`로 지정합니다. 설정이므로 `set_config`, `PATCH /config`, 대시보드의 결함 규칙 편집기로 바꿉니다.
- 코어는 `ctx.faults.decide(selector)`로 적용할 규칙을 받아 **자기 프로토콜에 맞게** 적용합니다.
  - 규칙은 배열 순서대로 보고, `match`가 맞고 `probability` 판정을 통과한 첫 규칙 하나만 적용합니다.
  - `match`의 모든 키가 selector의 같은 키와 같으면 맞는 것입니다. `match`가 없으면 모든 요청에 맞습니다.
  - 한 규칙 안의 `delayMs`와 다른 효과(`error`, `disconnect`, `corrupt`)는 함께 적용됩니다. 지연 뒤에 효과가 옵니다.
- 결함이 적용될 때마다 `testbed.fault.injected` 이벤트가 남습니다(규칙 id, 효과, `correlationId`로 원 요청과 연결).
- 지원하는 결함 종류는 코어가 선언하고(`faults`), 스펙의 결함 표에 적습니다. 지원하지 않는 종류를 지정하면 설정 검증에서 거절합니다.
- 결함 주입은 코어별 선택 기능입니다. 다만 쓰는 코어는 반드시 이 형식을 따릅니다.
- `times`로 비활성이 된 규칙은 설정에 남고, `reset`이나 설정 변경 때 횟수가 초기화됩니다.

## 2. 재현성

- 무작위 동작은 모두 `ctx.rng`(seed를 줄 수 있는 PRNG)로 합니다. `Math.random()` 직접 사용은 ESLint로 막습니다(`src/server/testbed/cores/**`).
- seed는 Run을 시작할 때 줄 수 있고, 주지 않으면 생성해서 Run 메타에 기록합니다. Run 밖에서는 부팅 때 만든 seed를 씁니다.
- 외부 코어에는 `initialize`와 `runChanged`의 `seed`로 전달합니다.
- 결함 판정(`probability`, `delayMs` 범위)도 `ctx.rng`를 씁니다.
- 시간과 동시성 때문에 완전한 재현은 보장하지 않습니다. 보장 범위는 **"같은 seed면 같은 결함 판정 순서, 같은 생성 데이터"**입니다.

## 3. 코드 위치

- `FaultRule` 타입: `src/shared/testbed/faults.ts`
- `SeededRng`(seed 문자열의 sha256으로 시작하는 sfc32), `generateSeed`: `src/server/testbed/rng.ts`
- `FaultDecider`(`ctx.faults`): `src/server/testbed/faults.ts`. `decide(selector, correlationId?)`가 적용할 규칙의
  효과(`ruleId`, `delayMs`, `error`, `disconnect`, `corrupt`)를 돌려주고, 적용할 때마다 `testbed.fault.injected`를
  내도록 받은 콜백을 부릅니다. `setRules`와 `reset`은 `times` 횟수를 초기화합니다.
- `RunManager.rng()`가 열린 Run의 rng(그 Run의 seed), Run 밖이면 부팅 rng를 돌려줍니다.
