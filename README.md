# Codex Session Coordination

같은 로컬 App Server를 사용하는 Codex 세션의 상태를 조회하고, 정확히 지정한 세션에 메시지를 넣는 도구입니다. `session-coordination` 스킬과 Node helper를 함께 관리합니다.

조회와 스티어링은 `codex app-server proxy`를 사용합니다. `send`는 실행 중인 턴에 메시지를 추가하고, 스티어링이 불가능하다고 확인된 경우에만 `codex queue`로 전달합니다. 세션 상태와 전달 결과의 정본은 Codex입니다. 이 도구는 daemon을 시작하거나 재설정하지 않습니다.

## 실행 환경

- Linux, Bash와 GNU 사용자 도구(`getent`, `id`, `cut`, `find`, `sort`, `cmp`, `install`, `mktemp`, `mv`).
- Node **24.20.0**. 현재 helper는 정확한 버전을 검사합니다.
- `codex app-server proxy`와 `codex queue`, App Server의 `thread/turns/list`·`turn/steer`를 제공하는 Codex CLI와 실행 중인 공유 로컬 App Server. 확인한 CLI는 **0.153.4**이며 다른 버전과의 호환성은 별도 확인이 필요합니다.
- `self`와 `send`는 현재 Codex 세션이 제공하는 `CODEX_THREAD_ID`가 필요합니다. 임의의 발신자 ID를 설정하지 않습니다.

실행 시 추가 npm 패키지는 필요하지 않습니다. 개발 검사는 lockfile에 고정된 TypeScript와 Node 타입을 사용합니다.

## 설치와 갱신

저장소를 clone한 뒤 검토한 커밋을 선택하고 스킬을 설치합니다.

```bash
git clone https://github.com/park285/codex-session-coordination.git
cd codex-session-coordination
git checkout --detach <reviewed-commit-sha>
bash sync-session-coordination-skill.sh --apply
bash sync-session-coordination-skill.sh --check
```

기본 설치 위치는 현재 사용자의 `~/.codex/skills/session-coordination/`입니다. 다른 스킬 디렉터리는 `CODEX_SESSION_COORDINATION_SKILLS_ROOT`로 지정합니다. 기존 설치의 예상하지 못한 파일이나 심볼릭 링크는 오류로 거부합니다.

갱신할 때는 `git fetch origin`으로 변경을 받아 검토한 커밋으로 이동한 뒤 동일한 `--apply`와 `--check`를 실행합니다. 설치 사본을 직접 편집하지 않습니다. 다른 프로젝트에서는 설치된 `$session-coordination` 스킬을 사용하면 됩니다.

## 명령

저장소 root에서 직접 실행할 수도 있습니다.

```bash
node session-coordination/scripts/sessionctl.mjs self
node session-coordination/scripts/sessionctl.mjs list --limit 10
node session-coordination/scripts/sessionctl.mjs status '<session-uuid-or-exact-name>'
```

사용자가 대상과 메시지 전송을 승인했을 때 다음 명령을 사용합니다.

```bash
node session-coordination/scripts/sessionctl.mjs send '<session-uuid-or-exact-name>' '검토한 메시지'
```

전송 대상은 UUID 또는 중복되지 않는 정확한 세션 이름이어야 합니다. 메시지에는 발신 세션 이름, UUID, `reply_to`와 처리 안내를 담은 `[CODEX SESSION MESSAGE]` envelope이 붙습니다. Envelope은 표시용 정보이며 인증된 발신 증명이 아닙니다.

`send`는 전송 직전의 런타임 상태를 확인합니다. 실행 중이면 대화 내용을 제외한 최신 턴 메타데이터만 조회하고, `expectedTurnId`를 지정해 `turn/steer`를 한 번 호출합니다. 다음 경우에만 기존 큐로 폴백합니다.

- 세션이 `idle`·`notLoaded`이거나 정상적인 최신 턴 조회에서 실행 중인 턴이 없습니다.
- 서버가 RPC 코드 `-32602`와 함께 `no active turn to steer`, `cannot steer a review turn`, `cannot steer a compact turn` 중 하나를 정확히 반환합니다. 이 문구는 Codex 0.153.4 기준입니다.

턴 ID 불일치, API 미지원, 그 밖의 오류는 큐 폴백 조건이 아닙니다. `systemError`나 실패·불완전한 상태 조회도 실행 중인 턴이 없다는 뜻으로 취급하지 않습니다.

| 결과 | 의미 |
|---|---|
| `delivery: "steer"`, `status: "accepted"` | 지정한 `turnId`에 스티어링 입력이 접수됐습니다. |
| `delivery: "queue"`, `status: "queued"` | native queue가 접수했습니다. `fallbackReason`은 `no_active_turn`, `review`, `compact` 중 하나입니다. |
| `status: "rejected"` | 요청이 거절됐습니다. 선택한 전송 경로와 오류를 확인합니다. |
| `status: "outcome_unknown"` | 전송 후 시간 초과, 연결 끊김, 잘못된 응답 등으로 접수 여부를 확인할 수 없습니다. |

`accepted`·`queued`는 수신 세션이 읽거나 작업을 완료했다는 뜻이 아닙니다. `idle`·`notLoaded`도 작업 완료를 증명하지 않습니다. 접수 여부가 불명확하면 자동 폴백이나 재전송을 하지 않습니다. 별도 수신 확인 기능은 없으므로 실제 반영 여부는 수신 세션의 명시적인 답변 등으로 확인해야 합니다.

`list`의 기본 개수는 25이며 1–100까지 지정할 수 있습니다. `CODEX_SESSION_COORDINATION_TIMEOUT_MS`는 요청 대기 시간을 밀리초로 지정하며 기본 5,000, 허용 범위 50–30,000입니다. 전송 시간이 초과하면 `outcome_unknown`을 반환합니다. 자식 프로세스가 종료하지 않으면 250ms의 유예 뒤 강제 종료하고 파이프를 정리합니다. 원격 Codex 호스트와 subagent 위임은 이 스킬의 범위에 포함되지 않습니다.

## 검증

개발 검사에는 npm, ripgrep, jq, ShellCheck도 필요합니다.

```bash
npm run check
```

`check`는 고정 의존성을 설치하고 전체 JS 모듈의 문법·타입, 셸 스크립트, 테스트와 설치 사본을 검사합니다. 타입 검사에는 `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`와 미사용 코드 검사를 적용합니다. GitHub Actions도 같은 명령을 실행합니다.

테스트만 실행하려면 다음 명령을 사용합니다. 가짜 프로세스와 Codex 응답으로 스티어링, 큐 폴백, 중복 전송 방지, 종료 처리, 오류, 새 설치와 기존 설치의 갱신을 확인하며 실제 메시지는 보내지 않습니다.

```bash
npm test
```

## 코드 구성

`sessionctl.mjs`는 명령과 세션 데이터, 스티어링과 폴백 판단을 처리합니다. `lib/app-server.mjs`는 WebSocket·JSON-RPC 통신, `lib/queue.mjs`는 폴백 시 native queue 전송을 담당합니다. 두 모듈은 `lib/process.mjs`의 진단 출력·종료 처리를 공유하며, 입력 검증과 오류 형식은 `lib/validation.mjs`에 있습니다.

설치 파일 목록은 `skill-files.txt`에서 관리합니다. 모듈을 먼저 설치하고 CLI 진입점을 마지막에 교체합니다.

## 라이선스

[Apache-2.0](LICENSE)
