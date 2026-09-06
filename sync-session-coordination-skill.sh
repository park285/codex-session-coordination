#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="${script_dir}/session-coordination"
mode="${1:---check}"

if [[ -n "${CODEX_SESSION_COORDINATION_SKILLS_ROOT:-}" ]]; then
  target_root="${CODEX_SESSION_COORDINATION_SKILLS_ROOT}"
else
  passwd_record="$(getent passwd "$(id -u)")"
  user_root="$(cut -d: -f6 <<<"${passwd_record}")"
  if [[ -z "${user_root}" || "${user_root}" == "/" ]]; then
    echo "sync-session-coordination-skill: cannot resolve a safe user directory" >&2
    exit 1
  fi
  target_root="${user_root}/.codex/skills"
fi

case "${mode}" in
  --check|--apply) ;;
  *)
    echo "sync-session-coordination-skill: usage: $0 [--check|--apply]" >&2
    exit 2
    ;;
esac

# 모듈을 먼저 설치하고 마지막에 CLI 진입점을 교체해 기존 설치를 갱신합니다.
mapfile -t managed_paths < "${script_dir}/skill-files.txt"
if (( ${#managed_paths[@]} == 0 )); then
  echo "sync-session-coordination-skill: skill file manifest is empty" >&2
  exit 1
fi
target_dir="${target_root}/session-coordination"
temporary_file=""

cleanup() {
  if [[ -n "${temporary_file}" && -f "${temporary_file}" && ! -L "${temporary_file}" ]]; then
    rm -- "${temporary_file}"
  fi
}
trap cleanup EXIT

if [[ -L "${target_root}" || -L "${target_dir}" ]]; then
  echo "sync-session-coordination-skill: refusing symlink target root" >&2
  exit 1
fi

if [[ -d "${target_dir}" ]]; then
  installed_symlink="$(find "${target_dir}" -type l -print -quit)"
  if [[ -n "${installed_symlink}" ]]; then
    echo "sync-session-coordination-skill: refusing installed symlink: ${installed_symlink}" >&2
    exit 1
  fi
  while IFS= read -r installed_file; do
    relative_path="${installed_file#"${target_dir}/"}"
    expected=false
    for managed_path in "${managed_paths[@]}"; do
      if [[ "${relative_path}" == "${managed_path}" ]]; then
        expected=true
        break
      fi
    done
    if [[ "${expected}" != true ]]; then
      echo "sync-session-coordination-skill: refusing unmanaged installed file: ${installed_file}" >&2
      exit 1
    fi
  done < <(find "${target_dir}" -type f -print)
fi

for relative_path in "${managed_paths[@]}"; do
  source_file="${source_dir}/${relative_path}"
  target_file="${target_dir}/${relative_path}"
  if [[ ! -f "${source_file}" || -L "${source_file}" ]]; then
    echo "sync-session-coordination-skill: source must be a regular non-symlink file: ${source_file}" >&2
    exit 1
  fi
  if [[ "${mode}" == "--check" ]]; then
    if [[ ! -f "${target_file}" || -L "${target_file}" ]] || ! cmp -s "${source_file}" "${target_file}"; then
      echo "sync-session-coordination-skill: drift: ${target_file}" >&2
      exit 1
    fi
    continue
  fi
  if [[ -L "${target_file}" ]]; then
    echo "sync-session-coordination-skill: refusing symlink target: ${target_file}" >&2
    exit 1
  fi
  mkdir -p "$(dirname "${target_file}")"
  temporary_file="$(mktemp "${target_file}.tmp.XXXXXX")"
  install -m 0644 "${source_file}" "${temporary_file}"
  mv -f -- "${temporary_file}" "${target_file}"
  temporary_file=""
done

echo "ok: session coordination skill source and installation match (${#managed_paths[@]} files, mode=${mode})"
