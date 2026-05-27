# opencode-discord-presence

[![npm version](https://img.shields.io/npm/v/opencode-discord-presence.svg)](https://www.npmjs.com/package/opencode-discord-presence)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenCode 세션 상태를 Discord Rich Presence로 표시합니다. 현재 사용 중인 AI 에이전트, 모델, 프롬프트/파일 활동 등을 Discord에서 확인할 수 있습니다.

## 기능

- **실시간 에이전트 표시** - 현재 사용 중인 AI 에이전트 (Claude, Prometheus 등) 표시
- **모델 정보** - 활성 모델 표시 (Claude Sonnet, GPT-4 등)
- **Discord 경과 타이머** - Presence에 Discord 시작 타임스탬프가 포함되어 클라이언트 타이머 UI에서 경과 시간이 표시됩니다
- **한국어 지원** - 한국어 조사 자동 처리 (을/를, 은/는)
- **유휴 감지** - 휴식 중일 때 자동으로 상태 변경
- **라이브 파일 스포트라이트** - 에이전트가 편집, 읽기, 진단 중인 파일을 언어별 Discord 아이콘과 함께 표시
- **태스크 미션 보드** - 활성 태스크 레이블과 완료 카운트 (예: "다크 모드 구현 중 (2/5)")로 진행 상황 표시
- **Diagnostics 표시 준비** - 향후/외부 통합을 위한 diagnostics 표시 표면을 유지하지만, 현재 OpenCode 플러그인 API v1은 diagnostics 이벤트만 로그하고 카운트를 제공하지 않습니다 (see [제한사항](#제한사항))
- **스마트 로테이션** - 심각한 상태 (오류, 유휴, 모두 완료)는 고정; 정보성 카드 (파일 스포트라이트, 미션 보드, 세션 통계)는 기본 20초마다 순환
- **세션 되돌아보기** - 세션이 종료되면 30초 동안 총 프롬프트 수와 수정된 파일 수를 표시

## 설치

```bash
# bun 사용
bun add opencode-discord-presence

# npm 사용
npm install opencode-discord-presence

# pnpm 사용
pnpm add opencode-discord-presence
```

## 빠른 시작

`opencode.json`에 플러그인을 등록하세요:

```json
{
  "plugin": ["opencode-discord-presence"]
}
```

끝! 플러그인이 자동으로 Discord에 연결되어 세션 상태를 표시합니다.

> `opencode.json`은 플러그인을 **등록**하는 용도일 뿐, 플러그인 설정은 모두 `.discord-presence.json` 또는 환경변수로 관리합니다. 아래 [설정](#설정) 섹션 참고.

## 설정

프로젝트 루트(권장) 또는 홈 디렉토리에 `.discord-presence.json` 파일을 생성하세요:

```json
{
  "enabled": true,
  "applicationId": "YOUR_DISCORD_APP_ID",
  "language": "ko",
  "richPresence": {
    "enableFileSpotlight": false,
    "enableMissionBoard": true,
    "mainAgentOnly": false,
    "rotationIntervalSeconds": 20,
    "diagnostics": {
      "errorsOnly": true
    }
  }
}
```

> ⚠️ `enableFileSpotlight`는 **기본값이 `false`**입니다. 켜면 지금 편집 중인 파일 경로가 Discord 프로필을 보는 모든 사람에게 노출됩니다. 공개 저장소이거나 노출돼도 괜찮을 때만 명시적으로 켜주세요.

또는 환경변수를 사용할 수 있습니다:

```bash
OPENCODE_DISCORD_ENABLED=true
OPENCODE_DISCORD_CLIENT_ID=YOUR_APP_ID
OPENCODE_DISCORD_LANGUAGE=ko
OPENCODE_DISCORD_DEBUG=true
```

### 설정 옵션

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 플러그인 활성화/비활성화 |
| `applicationId` | `string` | (내장) | 커스텀 브랜딩을 위한 Discord Application ID |
| `language` | `string` | `"en"` | 표시 언어 (`"en"` 또는 `"ko"`) |
| `debug` | `boolean` | `false` | `[discord-presence]` 라이프사이클 로그(연결/해제/실패) 출력 여부. 기본값이 `false`라 OpenCode 콘솔에 아무것도 안 찍힙니다. |
| `richPresence.enableFileSpotlight` | `boolean` | `false` | 현재 편집/읽기 중인 파일 경로를 표시. **개인정보 보호 차원에서 기본값 `false`** — Discord는 활동 정보를 프로필을 보는 모든 사람에게 노출하므로, 작업 중인 파일 경로가 비공개 저장소 내부 구조를 드러낼 수 있음. 괜찮다고 판단되면 명시적으로 켜세요. |
| `richPresence.enableMissionBoard` | `boolean` | `true` | 태스크 미션 보드 카드 표시 |
| `richPresence.rotationIntervalSeconds` | `number` | `20` | 정보성 카드 순환 주기 (10–60초) |
| `richPresence.mainAgentOnly` | `boolean` | `false` | `true`로 설정하면 **메인 세션** (root, `parentID` 없음) 의 `chat.message`만 Discord presence를 갱신합니다. sub-agent / task 세션 (planner, explore 등)은 필터링되어 사용자 프로필이 백그라운드 에이전트로 깜빡이지 않습니다. `false` (기본값)이면 모든 chat.message가 presence를 덮어쓰며 (last-writer-wins), orchestrator는 여전히 모든 세션의 busy/idle을 추적하여 "휴식중" 텍스트는 모든 세션이 idle일 때만 표시됩니다. |
| `richPresence.diagnostics.errorsOnly` | `boolean` | `true` | 향후/외부 diagnostics 통합을 위한 예약 옵션이며, 현재 OpenCode 플러그인 API v1에서는 비활성 상태입니다 |

하위 호환성을 위해 파서는 `discordPresence.applicationId`도 허용하지만, 새 설정은 위 예시처럼 최상위 `applicationId`를 사용하는 것을 권장합니다.

### 설정값이 읽히는 순서

각 옵션은 아래 순서대로 처음 정의된 값을 사용합니다:

1. **`<프로젝트루트>/.discord-presence.json`** — `opencode.json` 옆에 두는 프로젝트별 설정. 프로젝트마다 다른 언어/디버그 옵션을 쓰고 싶을 때 권장.
2. **`~/.discord-presence.json`** — 모든 OpenCode 프로젝트에서 공통으로 쓰는 전역 기본값.
3. **환경변수** — `OPENCODE_DISCORD_ENABLED`, `OPENCODE_DISCORD_CLIENT_ID`, `OPENCODE_DISCORD_LANGUAGE`, `OPENCODE_DISCORD_DEBUG`. 일회성 오버라이드에 편함 (`OPENCODE_DISCORD_DEBUG=true opencode …`).
4. **내장 기본값** — 조용한 모드(`debug: false`), 영어, 내장 Discord App ID.

> `opencode.json` 자체는 이 플러그인의 **설정 소스가 아닙니다**. `opencode.json` 안에 `discordPresence: { … }`를 적어도 읽히지 않으니, 설정은 반드시 `.discord-presence.json`에 넣어주세요. (OpenCode 공용 스키마가 플러그인별 필드를 허용하지 않기 때문에, `opencode.json`을 깨끗하게 유지하는 의도입니다.)

### 프로젝트별 예시

```bash
# 어느 OpenCode 프로젝트든, opencode.json 옆에:
cat > .discord-presence.json <<'JSON'
{
  "language": "ko",
  "debug": false,
  "richPresence": {
    "rotationIntervalSeconds": 15
  }
}
JSON
```

OpenCode를 재시작하면 다음 chat 메시지부터 새 설정이 반영됩니다.

## 커스텀 Discord Application

커스텀 브랜딩 (자신만의 이미지와 앱 이름)을 원한다면:

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속
2. "New Application" 클릭 후 이름 입력
3. "Rich Presence" → "Art Assets" 이동
4. 이미지 업로드 (최소 하나는 `opencode-logo`로 이름 지정)
5. "General Information"에서 Application ID 복사
6. 설정에 추가:

```json
{
  "applicationId": "YOUR_APPLICATION_ID"
}
```

## 작동 방식

플러그인은 OpenCode의 이벤트 시스템에 연결됩니다:

- **chat.message** - 메시지 송수신 시 현재 에이전트와 모델을 추적하여 presence 업데이트
- **tool.execute.before** / **tool.execute.after** - 파일 컨텍스트 및 도구 작업 레이블 캡처 (편집, 읽기, 검색, 빌드, 테스트 등)
- **file.edited** - 편집된 파일 경로와 언어 아이콘으로 라이브 파일 스포트라이트 업데이트
- **todo.updated** - 활성 태스크 레이블과 완료 카운트로 미션 보드 진행 상황 업데이트
- **session.idle** - 상태 줄에 마지막 활성 태스크와 함께 유휴 상태 표시
- **session.deleted** - 세션 종료 후 30초 동안 총 프롬프트 수와 수정된 파일 수 표시

### 제한사항

- **lsp.client.diagnostics**는 등록되어 있지만, OpenCode 플러그인 API v1에서는 오류/경고 카운트를 사용할 수 없습니다. Presence에 표시되는 진단 카운트는 외부 LSP 구성이 필요합니다. 플러그인은 diagnostics 이벤트를 로그하지만 카운트를 임의로 생성하지 않습니다.

### Presence 상태

| 상태 | 영어 | 한국어 | 설명 |
|------|------|--------|------|
| 활성 (편집) | `Working with {agent}` | `{agent}을/를 작업중` | 편집 중인 파일 |
| 활성 (읽기) | `Working with {agent}` | `{agent}을/를 작업중` | 읽고 있는 파일 |
| 태스크 활성 | `Working with {agent}` | `{agent}을/를 작업중` | 미션 진행 상황과 함께 |
| Diagnostics 오류 | `Working with {agent}` | `{agent}을/를 작업중` | 오류 감지됨 |
| 유휴 | `{agent} is idle` | `{agent}은/는 휴식중` | 활동 없음 |
| 세션 완료 | `Session Complete!` | `세션 완료!` | 세션 종료 (30초) |
| 모든 태스크 완료 | `All tasks complete!` | `모든 작업 완료!` | 보류 중인 태스크 없음 |

한국어 조사 (을/를, 은/는)는 에이전트 이름의 받침 유무에 따라 자동으로 선택됩니다.

## 시각적 샘플 매트릭스

다음 상태들은 v1에서 완전 지원됩니다 (런타임 기반):

| 조건 | 제목 | 상태 줄 | 큰 이미지 |
|------|------|---------|-----------|
| 파일 편집 | `Working with Claude` | `src/plugin.ts` | 언어 아이콘 |
| 파일 읽기 | `Working with Claude` | `src/services/discord-rpc.ts` | action-reading |
| 태스크 활성 | `Working with Claude` | `Implementing dark mode (2/5)` | task |
| Diagnostics 오류 | `Working with Claude` | `5 errors, 2 warnings` / `오류 5개, 경고 2개` | state-error |
| 유휴 | `Claude is idle` | `마지막 작업: Add theme toggle` | state-idle |
| 세션 되돌아보기 | `Session Complete!` / `세션 완료!` | `27 prompts • 3 files` / `27개 프롬프트 • 3개 파일` | state-recap |
| 모든 태스크 완료 | `All tasks complete!` / `모든 작업 완료!` | `5/5 finished` / `5/5 완료` | state-complete |

설명용 상태 (v1 미구현):

| 조건 | 제목 | 상태 줄 | 메모 |
|------|------|---------|------|
| 나이트 모드 | `Burning the midnight oil` | `src/index.ts` | 시간 기반 설정 추가 없이는 v1 미지원 |

## 개발

```bash
# 의존성 설치
bun install

# 테스트 실행
bun test

# 테스트 watch 모드
bun test --watch

# 타입 체크
bun run typecheck

# 린트
bun run lint

# 포맷
bun run format

# 빌드
bun run build
```

## 아키텍처

```
src/
├── index.ts              # 메인 진입점 & exports
├── plugin.ts             # OpenCode hook 등록 + presence 엔진
├── config.ts             # 설정 관리
├── types/
│   └── index.ts          # TypeScript 타입 정의
├── services/
│   └── discord-rpc.ts    # Discord RPC 서비스 (수명주기 강화됨)
├── state/
│   └── presence-state.ts # 인스턴스 범위 presence 스냅샷 + 리듀서
└── utils/
    ├── activity-rotation.ts # 우선순위 + 로테이션 엔진
    ├── file-label.ts        # 경로 정제 + 잘라냄
    ├── file-icons.ts        # 언어 → 아이콘 매핑
    ├── session-metrics.ts   # 세션 카운터 + 되돌아보기
    ├── tool-label.ts        # 도구 → 작업 레이블 매핑
    └── particle.ts          # 한국어 조사 처리 (을/를, 은/는)
```

## 기여하기

기여를 환영합니다! 자세한 내용은 [Contributing Guide](CONTRIBUTING.md)를 참조하세요.

### 빠른 기여 가이드

1. 저장소 Fork
2. 기능 브랜치 생성 (`git checkout -b feature/amazing-feature`)
3. 테스트 실행 (`bun test`)
4. 변경사항 커밋 (`git commit -m 'feat: add amazing feature'`)
5. 브랜치에 푸시 (`git push origin feature/amazing-feature`)
6. Pull Request 열기

## 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

## 관련 프로젝트

- [OpenCode](https://github.com/opencode-ai/opencode) - 이 플러그인이 확장하는 AI 코딩 어시스턴트
- [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) - 이 플러그인에서 사용하는 Discord RPC 라이브러리

## 변경 이력

[CHANGELOG.md](CHANGELOG.md)에서 릴리스 이력을 확인하세요.
