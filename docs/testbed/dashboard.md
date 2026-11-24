# 대시보드

메인 페이지 `/`가 대시보드입니다. `testbed-base`가 셸과 공통 컴포넌트를 주고, 각 테스트베드는 고유 화면을 **패널 슬롯**에 등록합니다. 셸은 고치지 않습니다.

## 1. 공통 컴포넌트

| 컴포넌트          | 내용                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 상태 바           | 이름, 버전, 인스턴스, 코어별 상태 점, 열린 Run, 락 배너                                                                    |
| 연결 패널         | 데이터면 주소(복사 버튼), 제어면 MCP URL, `.mcp.json` 조각, CLAUDE.md 스니펫 복사                                          |
| 코어 카드         | 상태, start/stop/reset, 설정 편집(스키마 기반 JSON 편집기가 기본, 코어가 전용 폼으로 대체 가능), 액션 버튼, 결함 규칙 편집 |
| 이벤트 로그       | 가상 스크롤. 필터: core, kind, level, actor, run, 검색. 위로 스크롤하면 따라가기를 멈춤. 생략 건수 표시                    |
| 상세 패널         | 봉투 + payload JSON 뷰어, 가린 값 표시, 같은 correlationId 묶음 보기                                                       |
| 통계 패널         | kind별 건수, 오류율, `latencyMs`가 있으면 평균·p95·최대                                                                    |
| Run 패널          | 현재 Run, 지난 Run 목록, 요약, check 결과, 내보내기, 다른 주체가 닫은 Run 표시                                             |
| 에이전트 타임라인 | actor=`agent`인 이벤트와 `testbed.control.*`, `testbed.lease.*`만 시간순으로 보여 줌                                       |

### 1.1 영역

| 영역      | 위치(1024px 이상)                    | 1024px 미만                                                    |
| --------- | ------------------------------------ | -------------------------------------------------------------- |
| 상태 바   | 맨 위, 그 아래 락 배너·재시작 알림   | 같음                                                           |
| 코어 열   | 왼쪽. 연결 패널, 코어(카드는 P3 M8)  | "코어와 연결" 버튼 → 보일러플레이트 사이드바(`Sidebar`, modal) |
| 주 영역   | 가운데. 탭(공통 탭 + 코어 고유 패널) | 같음                                                           |
| 상세 패널 | 오른쪽(내용은 P3 M9)                 | "상세" 버튼 → 바텀시트(`BottomSheet`)                          |

- 주 영역 탭은 이벤트 로그(`events`), 통계(`stats`), Run(`runs`), 에이전트 타임라인(`agent`), 그다음 코어 고유 패널(`<core>.<panel id>`) 순서입니다. 선택한 탭은 주소 `?tab=<id>`에 남습니다.
- 상태 바: 이름, 버전, `instanceId` 앞 8자, 코어별 상태 점(색 + `aria-label` "`<core>: <state>`"), 열린 Run(label과 경과 시간, 1초마다 갱신), 실시간 연결 상태(연결 중 / 연결됨 / 다시 연결 중).
- `AUTH_DRIVER=oidc`인데 로그인하지 않았으면 대시보드 대신 "로그인 필요" 안내와 보일러플레이트의 로그인 컨트롤을 보여 줍니다. 판정: WS가 아무 메시지 없이 닫히면 `GET /testbed/api/status`를 불러 보고, 401이면 로그인 필요로 보고 다시 연결하지 않습니다.
- 구현: `src/client/testbed/dashboard/`(셸), `src/client/testbed/store/`(스토어), `src/client/testbed/registry.ts`(패널 슬롯), `src/client/testbed/connection.ts`(연결 패널 조각).

### 1.2 연결 패널 조각

모든 주소는 매니페스트의 `publicUrl`(`TESTBED_PUBLIC_URL`)로 만듭니다. 데이터면 주소는 실시간 상태의 것을 씁니다(포트 `0`으로 다시 연 코어는 주소가 바뀜).

- 제어면 MCP URL: `<publicUrl>/testbed/mcp`
- `.mcp.json` 조각. 서버 이름은 `tb-<name에서 앞의 'testbed-'를 뺀 것>`입니다. 매니페스트 `auth.control`이 `bearer`면 `headers`를 넣습니다.

  ```json
  {
    "mcpServers": {
      "tb-llm": {
        "type": "http",
        "url": "http://host:40020/testbed/mcp",
        "headers": { "Authorization": "Bearer ${TESTBED_CONTROL_TOKEN}" }
      }
    }
  }
  ```

- 제품 레포 CLAUDE.md 스니펫(틀): 테스트베드 이름과 용도 한 줄, MCP 서버 이름과 URL, 기본 흐름(`testbed_info` → `start_run` → 제품 작업 → `check` → `end_run` → `release_control`), 데이터면 주소 목록. 테스트베드마다 덧붙일 문장은 매니페스트에 아직 없습니다.

## 2. 제어 락 표시

- 락이 걸리면 모든 조작 컨트롤을 비활성화합니다(`aria-disabled="true"`, `<html data-lease="agent">` 또는 `data-lease="ci"`). 락이 없으면 `data-lease="none"`입니다. 조작 컨트롤은 모두 `useCanOperate()`(락이 없을 때만 `true`) 하나로 비활성 여부를 정합니다.
- 상단 배너: "<보유자 이름 또는 actor>가 제어 중 · 세션 ab12 · 남은 시간 08:41". 이름은 보유자의 표시 이름(MCP `clientInfo.name`)을 쓰고, 남은 시간은 1초마다 줄어듭니다(받은 `remainingMs`에서 받은 뒤 흐른 시간을 뺌).
- 대시보드에는 강제 해제 버튼을 두지 않습니다.

### 2.1 편집하던 중에 잠길 때

- 편집 컴포넌트(설정 편집기, 액션 폼, 결함 규칙 편집기)는 락이 걸려도 **입력을 지우지 않고** 읽기 전용으로 바뀝니다.
- 옆에 "Claude Code가 제어를 시작해 저장할 수 없음 · 입력 복사" 안내를 띄웁니다.
- 저장을 누른 순간 잠겨 `423 LOCKED`를 받은 경우도 같은 안내를 띄우고 입력을 보존합니다.
- 락이 풀리면 편집을 다시 이어 갈 수 있습니다. 그 사이 서버 값이 바뀌었으면 "서버 값이 바뀜 · 다시 불러오기 / 내 입력 유지"를 고르게 합니다.
- 이 동작은 공통 편집 래퍼가 제공합니다. 코어 전용 폼도 같은 래퍼를 씁니다.

## 3. 규칙

- **스토어**(`src/client/testbed/store/`): React state 밖에 둡니다.
  - `/testbed/ws`의 `snapshot`으로 상태·이벤트를 채우고 `event`·`status`·`lease` 증분을 반영합니다.
  - 이벤트는 최근 5000건만 둡니다. `event` 묶음의 `omitted`(서버 표본화로 빠진 건수)는 누적합니다.
  - 끊기면 1초부터 2배씩 최대 10초 간격으로 다시 연결합니다. 다시 연결되면 새 `snapshot`으로 통째로 바꾸고, `instanceId`가 바뀌었으면 "테스트베드가 재시작됨" 알림을 한 번 띄웁니다.
  - 구독자에게는 최대 10Hz(100ms 묶음)로 알립니다. 컴포넌트는 `useSyncExternalStore`로 구독합니다.
  - 훅: `useTestbed()`(스냅샷 전체), `useTestbedStatus()`, `useLease()`, `useCanOperate()`, `useTestbedEvents(filter)`(`runId: 'current'`는 열린 Run).
- **REST 호출**: `src/client/api/endpoints.ts`의 `testbedApi`로만 부릅니다. 대시보드의 호출자는 사람입니다(`X-Testbed-Actor`를 보내지 않음). 락 획득·해제 엔드포인트는 목록에 두지 않습니다(사람은 락을 잡지 않음).

- **고빈도 렌더링**: 이벤트 상태는 React state 밖의 스토어에 두고 `useSyncExternalStore`로 약 10Hz 스냅샷을 구독합니다. 초당 수천 건의 이벤트를 React state로 다루면 렌더링이 따라가지 못하기 때문입니다. 차트는 자기 애니메이션 프레임으로 그립니다.
- **testid**: 보일러플레이트의 `TESTID` 레지스트리(`src/client/testing/testids.ts`, [../ui-automation.md](../ui-automation.md))를 씁니다. 공통 컴포넌트는 `TESTID.testbed.*`, 코어 고유 화면은 `TESTID.<core>.*`입니다. 락 상태는 `data-lease`와 `aria-disabled`로 관찰합니다.
- **디자인**: 보일러플레이트 디자인 시스템(스킨, 토큰, `src/client/ui/*`)을 그대로 씁니다.
- **코어는 브라우저에 두지 않습니다.** 화면은 보여 주고 REST로 명령을 보내기만 합니다.

## 4. 패널 슬롯

테스트베드는 셸을 고치지 않고 `src/client/testbed/cores/<core id>/index.ts`에서 모듈을 내보내고, `src/client/testbed/cores/index.ts`의 `CLIENT_CORES`에 올립니다(서버의 `cores/index.ts`와 같은 방식).

```ts
interface ClientCoreModule {
  core: string;
  panels?: { id: string; title: MessageKey; component: ComponentType }[]; // 주 영역 탭
  configForm?: ComponentType<ConfigFormProps>; // 설정 전용 폼(P3 M8). 없으면 JSON 편집기
}

interface ConfigFormProps {
  core: string;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  readOnly: boolean; // 락이 걸림
}
```

- 패널 탭의 id는 `<core>.<panel id>`이고 공통 탭 뒤에 붙습니다. 제목은 i18n 키(`src/shared/i18n/messages/*`)입니다.
- 고유 패널은 스토어 훅(`useTestbedEvents(filter)`, `useTestbedStatus()`, `useLease()`)과 `testbedApi`만 씁니다.
