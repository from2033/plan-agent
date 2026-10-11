#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_root="${PA_RUNTIME_ROOT:-${HOME}/.5656ai-runtime/production/personal-assistant}"
docker_cmd="${PA_DOCKER_CMD:-${HOME}/.5656ai-runtime/docker.sh}"
compose_file="$script_dir/mac-production/compose.yml"
state_dir="$runtime_root/deploy-state"
previous_image="$(cat "$state_dir/previous-image" 2>/dev/null || true)"

[[ -n "$previous_image" ]] || { printf 'No previous production image is recorded.\n' >&2; exit 1; }
"$docker_cmd" image inspect "$previous_image" >/dev/null

PA_RUNTIME_ROOT="$runtime_root" PA_IMAGE="$previous_image" \
  "$docker_cmd" compose --project-name personal-assistant-mac --file "$compose_file" up -d --force-recreate

healthy=false
for _ in $(seq 1 60); do
  status="$("$docker_cmd" inspect personal-assistant-mac-app-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  if [[ "$status" == healthy ]]; then healthy=true; break; fi
  [[ "$status" == exited || "$status" == dead ]] && break
  sleep 2
done
[[ "$healthy" == true ]]
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:13020/api/health | grep -q '"ok":true'
printf '%s\n' "$previous_image" > "$state_dir/current-image"
printf 'rolled_back_to=%s\n' "$previous_image"
