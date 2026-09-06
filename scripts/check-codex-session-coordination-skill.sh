#!/usr/bin/env bash
set -euo pipefail

bundle_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_dir="${bundle_root}/session-coordination"
syncer="${bundle_root}/sync-session-coordination-skill.sh"
required_node_version="v24.20.0"
managed_paths=(
  "SKILL.md"
  "agents/openai.yaml"
  "scripts/sessionctl.mjs"
)
toolchain_paths=(
  "package.json"
  "package-lock.json"
  "tsconfig.json"
)

actual_node_version="$(node --version)"
if [[ "${actual_node_version}" != "${required_node_version}" ]]; then
  echo "check-codex-session-coordination-skill: Node ${required_node_version#v} is required; found ${actual_node_version}" >&2
  exit 1
fi

for relative_path in "${toolchain_paths[@]}"; do
  source_file="${bundle_root}/${relative_path}"
  if [[ ! -f "${source_file}" || -L "${source_file}" ]]; then
    echo "check-codex-session-coordination-skill: invalid toolchain file: ${source_file}" >&2
    exit 1
  fi
done

for relative_path in "${managed_paths[@]}"; do
  source_file="${skill_dir}/${relative_path}"
  if [[ ! -f "${source_file}" || -L "${source_file}" ]]; then
    echo "check-codex-session-coordination-skill: invalid source file: ${source_file}" >&2
    exit 1
  fi
done

actual_files="$(find "${skill_dir}" -type f -printf '%P\n' | sort)"
expected_files="$(printf '%s\n' "${managed_paths[@]}" | sort)"
if [[ "${actual_files}" != "${expected_files}" ]]; then
  echo "check-codex-session-coordination-skill: bundle contains unmanaged files" >&2
  exit 1
fi

description="$(sed -n 's/^description: //p' "${skill_dir}/SKILL.md")"
if [[ -z "${description}" || ${#description} -gt 384 ]]; then
  echo "check-codex-session-coordination-skill: description must be 1-384 characters" >&2
  exit 1
fi
if ! rg -q '^name: session-coordination$' "${skill_dir}/SKILL.md"; then
  echo "check-codex-session-coordination-skill: skill name is missing" >&2
  exit 1
fi
if ! rg -q '^  allow_implicit_invocation: true$' "${skill_dir}/agents/openai.yaml"; then
  echo "check-codex-session-coordination-skill: invocation policy is missing" >&2
  exit 1
fi

node --check "${skill_dir}/scripts/sessionctl.mjs"
npm --prefix "${bundle_root}" ci --ignore-scripts --no-audit --no-fund >/dev/null
npm --prefix "${bundle_root}" run typecheck >/dev/null
bash -n "${syncer}"

if [[ -n "${CODEX_SESSION_COORDINATION_SKILLS_ROOT:-}" ]]; then
  target_root="${CODEX_SESSION_COORDINATION_SKILLS_ROOT}"
else
  passwd_record="$(getent passwd "$(id -u)")"
  user_root="$(cut -d: -f6 <<<"${passwd_record}")"
  if [[ -z "${user_root}" || "${user_root}" == "/" ]]; then
    echo "check-codex-session-coordination-skill: cannot resolve a safe user directory" >&2
    exit 1
  fi
  target_root="${user_root}/.codex/skills"
fi

if [[ -d "${target_root}/session-coordination" ]]; then
  CODEX_SESSION_COORDINATION_SKILLS_ROOT="${target_root}" bash "${syncer}" --check
  echo "ok: session coordination source bundle and installed copy match"
else
  echo "ok: session coordination source bundle passes; user installation is not present"
fi
