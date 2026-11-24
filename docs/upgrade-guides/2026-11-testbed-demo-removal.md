# 업스트림 업데이트 적용: 보일러플레이트 데모 제거 (2026-11, testbed-base)

`testbed-base`가 보일러플레이트의 데모(Todos·채팅)를 지운 변경입니다. 읽는 쪽은 둘입니다.

- **`testbed-base` 자신**: 보일러플레이트(`hwahee/boilerplate`)를 머지할 때마다 2절의 충돌 해결 원칙과 4절을
  따릅니다. 이 가이드는 한 번 적용하고 끝나는 것이 아니라 **보일러플레이트를 머지할 때마다** 다시 확인합니다.
- **테스트베드 레포**: `testbed-base`를 머지하면 삭제가 그대로 들어옵니다. 1절로 확인하고, 테스트베드 레포가
  데모 파일을 고쳤거나 데모에 기대고 있었다면 4절을 따릅니다.

| PR                                                  | 내용                                                           | main 머지 순서 |
| --------------------------------------------------- | -------------------------------------------------------------- | -------------- |
| [#1](https://github.com/hwahee/testbed-base/pull/1) | 데모 제거, 기본값(`memory`·`none`·`40000`), 이미지 job, README | 1              |

## 0. 작업 원칙

- 다운스트림의 `CLAUDE.md`가 업스트림과 다르면 **다운스트림 것이 우선**입니다.
- **3절의 결정 항목은 에이전트가 정하지 않습니다.** 사람에게 묻고, 답을 받기 전에는 기본값(각 항목에 적음)으로 둡니다.
- 각 단계 끝의 검증 명령이 통과해야 다음 단계로 갑니다.

## 1. 이미 적용됐는지 확인

| 확인                                                                                                                                       | 적용됨의 의미                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `git grep -n -i -E 'todo-service\|todos-page\|chat-gateway\|chat-service\|home-chat\|chat-room\|presence' -- src scripts` 결과가 비어 있음 | 데모 코드와 그 참조가 없음         |
| 아래 "지운 경로 확인" 명령이 아무것도 출력하지 않음                                                                                        | 지운 경로가 하나도 되살아나지 않음 |
| `grep -n "testbed.placeholder" src/client/testing/testids.ts`                                                                              | `/`가 빈 자리 페이지임             |

지운 경로 확인:

```sh
for p in \
  src/client/chat src/server/presence src/server/realtime src/server/repositories src/server/services \
  src/client/pages/home-chat.tsx src/client/pages/home-page.tsx src/client/pages/todos-page.tsx \
  src/server/routes/chat.ts src/server/routes/todos.ts src/server/http/chat.integration.test.ts \
  src/shared/domain/chat.ts src/shared/domain/chat.test.ts src/shared/domain/home-chat.ts \
  src/shared/domain/todo.ts src/shared/domain/todo.test.ts \
  scripts/chat-load.ts scripts/seed.ts; do
  test -e "$p" && echo "남아 있음: $p"
done
```

### 지운 경로

폴더째 지운 것(안의 파일 전부):

| 경로                       | 무엇이었나                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `src/client/chat/`         | 채팅 클라이언트 코어(소켓, 방 상태, 훅, 게스트 id)와 그 테스트   |
| `src/server/presence/`     | 채팅 접속자 목록 저장소(memory/redis)와 그 테스트                |
| `src/server/realtime/`     | 채팅 WebSocket 게이트웨이(`/ws/chat`)와 그 테스트                |
| `src/server/repositories/` | Todos·채팅·감사 로그 리포지토리(계약, memory, postgres)와 테스트 |
| `src/server/services/`     | `TodoService`, `ChatService`와 그 테스트                         |

파일 단위로 지운 것:

| 경로                                        | 무엇이었나                                    |
| ------------------------------------------- | --------------------------------------------- |
| `src/client/pages/home-chat.tsx`            | 홈의 채팅 상자                                |
| `src/client/pages/home-page.tsx`            | 홈(Todos + 채팅). `/`는 빈 자리 페이지로 바뀜 |
| `src/client/pages/todos-page.tsx`           | Todos 화면                                    |
| `src/server/routes/chat.ts`                 | `/api/chat/rooms/:roomId/messages`            |
| `src/server/routes/todos.ts`                | `/api/todos`, `/api/todos/:id`                |
| `src/server/http/chat.integration.test.ts`  | 채팅 HTTP·WebSocket 통합 테스트               |
| `src/shared/domain/chat.ts`, `chat.test.ts` | 채팅 도메인 타입·검증기                       |
| `src/shared/domain/home-chat.ts`            | 홈 채팅 방 정의                               |
| `src/shared/domain/todo.ts`, `todo.test.ts` | Todos 도메인 타입·검증기                      |
| `scripts/chat-load.ts`                      | 채팅 부하 테스트(`chat:load`)                 |
| `scripts/seed.ts`                           | Todos 시드(`db:seed`)                         |

### 공통 파일에서 뺀 부분

파일은 남기고 데모에 속한 부분만 뺐습니다. 머지 때 이 파일들에서 충돌이 나면 2절을 따릅니다.

| 파일                                        | 뺀 것                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/server/app.ts`                         | todos·채팅 라우트, `/ws`·`/ws/chat`, `websocket` 핸들러, `SocketData`            |
| `src/server/container.ts`                   | 리포지토리, `MemoryStore`, `todoService`, `chatService`, `chatGateway`, presence |
| `src/server/index.ts`                       | 홈 채팅 방 열기, todos pub/sub → WebSocket 브리지, 채팅 게이트웨이 시작          |
| `src/server/worker.ts`                      | `todo.created` 잡 핸들러, 채팅 보존 기한 정리                                    |
| `src/server/pubsub/types.ts`                | `CHANNELS.todosChanged`, `chatMessages`, `chatPresence`                          |
| `src/server/db/postgres.ts`                 | `createPostgresUnitOfWork`, `sessionSql`(리포지토리 계약에 기대던 것)            |
| `src/client/app.tsx`                        | `HomePage` → `PlaceholderPage`(`src/client/testbed/placeholder-page.tsx`)        |
| `src/client/api/endpoints.ts`, `queries.ts` | `todosApi`, `chatApi`, todos 쿼리 훅, `useCaller`(Todos 화면만 썼음)             |
| `src/client/testing/testids.ts`             | `todos.*`, `home.*` → `testbed.placeholder` 추가                                 |
| `src/shared/i18n/messages/*.ts`             | `todos.*`, `chat.*` 메시지 → `testbed.placeholder.*` 추가                        |
| `src/client/styles/main.css`                | Todos·홈 레이아웃·채팅 상자 스타일, kids 스킨의 `.todo-item` 선택자              |
| `src/server/http/api.integration.test.ts`   | todos 시험. 공통 미들웨어 시험은 남은 경로(`/api/auth/me`, `/api/*`)로 옮김      |
| `package.json`                              | `chat:load`, `db:seed` 스크립트, `db:setup`의 시드 단계                          |

`migrations/`는 그대로 둡니다(Todos·채팅 테이블이 스키마 이력에 남아 있어도 됩니다. 테스트베드는 기본
`DB_DRIVER=memory`라 DB를 쓰지 않습니다).

## 2. 충돌 해결 원칙

- **"한쪽은 수정, 한쪽은 삭제" 충돌**(보일러플레이트가 지운 데모 파일을 고친 경우): **삭제를 유지**합니다.

  ```sh
  git status --short | grep -E '^(DU|UD) '   # 수정/삭제 충돌 목록
  git rm <경로>                               # 경로마다
  ```

- **보일러플레이트가 데모와 공통 코드를 함께 고친 경우**: 공통 코드 쪽 변경만 받고, 데모를 되살리지 않습니다.
  예: 보일러플레이트가 `container.ts`에 새 공통 서비스를 더하면서 `todoService`도 고쳤다면, 새 공통 서비스만
  받고 `todoService`는 넣지 않습니다. `app.ts`·`index.ts`·`worker.ts`·`pubsub/types.ts`·`endpoints.ts`·
  `queries.ts`·`testids.ts`·i18n 메시지·`main.css`도 같습니다. 1절의 "공통 파일에서 뺀 부분" 표에 있는 것은
  되살리지 않습니다.
- **공통 미들웨어 테스트**: 보일러플레이트가 `api.integration.test.ts`의 todos 시험으로 공통 동작(에러 봉투,
  버전 핸드셰이크, CORS 등)을 새로 시험하면, 그 시험을 남은 경로(`/api/auth/me`, 없는 `/api/*` 경로)나
  `respond.test.ts`로 옮겨 받습니다. todos 시험 자체는 받지 않습니다.
- **보일러플레이트가 새 데모(예시 기능)를 추가한 경우**: 머지한 뒤 같은 원칙으로 지우고, 지운 경로를 1절의
  "지운 경로" 표와 "지운 경로 확인" 명령에 더합니다(같은 PR에서). 데모인지 공통 기능인지 판단이 서지 않으면
  3절을 따릅니다.
- **`README.md`**: `testbed-base`의 것을 유지합니다. 보일러플레이트 README의 변경은 받지 않습니다(자세한 설명은
  보일러플레이트 README를 링크로 봄).
- **기본값**: `.env.example`·`src/server/config.ts`·`Dockerfile`의 `PORT=40000`, `DB_DRIVER=memory`,
  `AUTH_DRIVER=none`은 `testbed-base` 쪽을 유지합니다. 보일러플레이트가 같은 파일에 새 변수를 더하면 그
  변수는 받습니다.

## 3. 사람에게 확인할 결정

| 결정                                                                                                  | 기본값(답을 받기 전)                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 보일러플레이트가 새로 더한 기능이 데모인지 공통 기능인지 분명하지 않을 때, 지울지                     | 지우지 않고 남겨 두고 PR에 적어 보고 |
| 테스트베드 레포가 지워진 데모 코드(예: 채팅 코어, `useCaller`)를 자기 기능에 쓰고 있었을 때, 되살릴지 | 머지를 멈추고 그 사용처를 보고       |

## 4. 조치

1. **`testbed-base`에서 보일러플레이트를 머지할 때**
   1. `git fetch upstream && git merge upstream/main` 후 충돌을 2절대로 풉니다.
   2. 1절의 확인 세 가지를 돌립니다. 되살아난 경로나 참조가 있으면 지웁니다.
   3. 보일러플레이트의 업그레이드 가이드 중 데모에만 해당하는 조치(예: 채팅 마이그레이션 번호, Todos 화면
      변경)는 건너뛰고, 건너뛴 사실을 PR에 적습니다.
   4. 검증: `bun run check` 통과.
2. **테스트베드 레포에서 `testbed-base`를 머지할 때**
   1. 삭제가 머지로 들어옵니다. 테스트베드 레포가 데모 파일을 고친 적이 있으면 수정/삭제 충돌이 나므로 2절대로
      삭제를 유지합니다.
   2. 테스트베드 코드가 지워진 것(`todosApi`, `chatApi`, `useCaller`, `CHANNELS.todosChanged` 등)을 참조하면
      `bun run typecheck`가 찾아 줍니다. 3절의 두 번째 결정을 따릅니다.
   3. 기본값이 `DB_DRIVER=memory`, `AUTH_DRIVER=none`, `PORT=40000`으로 바뀝니다. `.env`에 적어 둔 값은 그대로
      우선합니다. `40000`은 `testbed-base`의 포트 블록이므로, 테스트베드 레포는 `PORT` 기본값을 자기 블록의 +0으로
      바꿉니다([../testbed/ports.md](../testbed/ports.md)): `src/server/config.ts`의 기본값, `.env.example`,
      `Dockerfile`의 `ENV PORT`·`EXPOSE`. 같은 줄에서 충돌이 나면 자기 블록 값을 유지합니다.
   4. 검증: `bun run check` 통과, `.env` 없이 `bun run dev` → `curl -s -o /dev/null -w '%{http_code}' localhost:<자기 블록 +0>/`가
      `200`.

## 5. 완료 조건

- `bun run check` 통과.
- 1절의 확인 세 가지가 모두 "적용됨".
- 3절의 결정이 모두 사람에게서 왔거나 기본값으로 남아 있고, 그 사실을 보고함.

## 6. 되돌리기

- 코드: 이 변경의 머지를 되돌리면 데모가 돌아옵니다. 기본값도 보일러플레이트 것(`3000`, `postgres`)으로
  돌아가므로 `.env`에 `DB_DRIVER=memory`를 적거나 DB를 띄웁니다.
- 데이터: 데모가 쓰던 테이블은 지우지 않았으므로 되돌려도 데이터 조치는 없습니다.
