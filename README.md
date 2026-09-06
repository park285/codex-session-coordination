# Codex Session Coordination

같은 로컬 App Server를 사용하는 Codex 세션의 상태를 조회하고, 정확히 지정한 세션에 메시지를 넣는 도구입니다. `session-coordination` 스킬과 Node helper를 함께 관리합니다.

조회는 `codex app-server proxy`, 전송은 `codex queue`에 위임합니다. 세션 상태와 전달 결과의 정본은 Codex입니다. 이 도구는 daemon을 시작하거나 재설정하지 않습니다.

## 실행 환경

- Linux, Bash와 GNU 사용자 도구(`getent`, `id`, `cut`, `find`, `sort`, `cmp`, `install`, `mktemp`, `mv`).
- Node **24.20.0**. 현재 helper는 정확한 버전을 검사합니다.
- `codex app-server proxy`와 `codex queue`를 제공하는 Codex CLI, 실행 중인 공유 로컬 App Server. 분리 시 확인한 CLI는 **0.153.4**이며 다른 버전과의 호환성은 별도 확인이 필요합니다.
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

`queued`는 native queue 접수를 뜻하며 수신 세션이 읽거나 작업을 완료했다는 뜻이 아닙니다. `rejected`와 `outcome_unknown`은 구분해서 보존합니다. 결과가 불명확하면 실제 상태를 확인하기 전에는 재전송하지 않습니다. `idle`·`notLoaded` 역시 작업 완료를 증명하지 않습니다.

`list`의 기본 개수는 25이며 1–100까지 지정할 수 있습니다. `CODEX_SESSION_COORDINATION_TIMEOUT_MS`는 요청 대기 시간을 밀리초로 지정하며 기본 5,000, 허용 범위 50–30,000입니다. 원격 Codex 호스트와 subagent 위임은 이 스킬의 범위에 포함되지 않습니다.

## 검증

개발 검사에는 npm, ripgrep과 jq도 필요합니다.

```bash
npm run check
npm test
```

`check`는 고정 의존성을 `npm ci --ignore-scripts`로 설치하고 Node 문법, strict TypeScript, bundle 구성과 설치 사본의 일치를 검사합니다. `test`는 가짜 Codex proxy와 queue로 프로토콜, 정확한 대상 선택, 메시지 원문·envelope, 거절·불명확 결과, timeout과 설치 drift를 검증합니다. 테스트는 실제 세션에 메시지를 보내지 않습니다.

셸 변경에는 다음 검사도 실행합니다.

```bash
shellcheck sync-session-coordination-skill.sh scripts/*.sh
git diff --check
```

## 라이선스

[Apache-2.0](LICENSE)
