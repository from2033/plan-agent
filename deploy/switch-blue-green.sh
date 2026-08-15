#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: switch-blue-green.sh <registry-image:tag>}"
root="${PERSONAL_ASSISTANT_ROOT:-/opt/personal-assistant}"
deploy_dir="$root/deploy-blue-green"
router_dir="$root/router"
network="${PERSONAL_ASSISTANT_NETWORK:-deploy_default}"
env_file="${PERSONAL_ASSISTANT_ENV_FILE:-/etc/personal-assistant/server.env}"
active_file="$router_dir/active-slot"
previous="$(cat "$active_file" 2>/dev/null || true)"
if [[ "$previous" == blue ]]; then next=green; else next=blue; fi
next_container="personal-assistant-$next"
case "$previous" in
  blue|green) previous_container="personal-assistant-$previous" ;;
  legacy) previous_container="personal-assistant" ;;
  *) previous_container="" ;;
esac

[[ -f "$env_file" ]] || { echo "Missing runtime env: $env_file" >&2; exit 1; }
[[ -f "$deploy_dir/router/default.conf.template" ]] || { echo "Missing router template" >&2; exit 1; }
docker network inspect "$network" >/dev/null
docker pull "$image"
mkdir -p "$router_dir" "$root/backups"

backup_source=""
if [[ -n "$previous_container" ]] && docker inspect "$previous_container" >/dev/null 2>&1; then
  backup_source="$previous_container"
elif docker inspect personal-assistant >/dev/null 2>&1; then
  backup_source=personal-assistant
fi
paused=""
if [[ -n "$backup_source" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$backup_source")" == true ]]; then
  docker pause "$backup_source" >/dev/null
  paused="$backup_source"
fi
trap '[[ -n "$paused" ]] && docker unpause "$paused" >/dev/null 2>&1 || true' EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$root/backups/$stamp"
mkdir -p "$backup_dir"
for file in data.db data.db-wal data.db-shm; do
  [[ -f "$root/data/$file" ]] && cp -p "$root/data/$file" "$backup_dir/$file"
done
if [[ -n "$paused" ]]; then docker unpause "$paused" >/dev/null; fi
paused=""

docker rm -f "$next_container" >/dev/null 2>&1 || true
docker run -d \
  --name "$next_container" \
  --restart unless-stopped \
  --stop-timeout 60 \
  --network "$network" \
  --env-file "$env_file" \
  --volume "$root/data:/data" \
  --memory "${PERSONAL_ASSISTANT_MEMORY:-1024m}" \
  --memory-swap "${PERSONAL_ASSISTANT_MEMORY:-1024m}" \
  --cpus "${PERSONAL_ASSISTANT_CPUS:-1.0}" \
  --pids-limit "${PERSONAL_ASSISTANT_PIDS_LIMIT:-384}" \
  "$image" >/dev/null

healthy=""
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$next_container" 2>/dev/null || true)"
  if [[ "$status" == healthy ]]; then healthy=yes; break; fi
  [[ "$(docker inspect --format '{{.State.Status}}' "$next_container" 2>/dev/null || true)" == exited ]] && break
  sleep 2
done
if [[ "$healthy" != yes ]]; then docker logs "$next_container" --tail 100 >&2 || true; exit 1; fi

sed "s/__UPSTREAM__/$next_container/g" "$deploy_dir/router/default.conf.template" > "$router_dir/default.conf.next"
if docker inspect personal-assistant-router >/dev/null 2>&1; then
  cp "$router_dir/default.conf" "$router_dir/default.conf.previous"
  mv "$router_dir/default.conf.next" "$router_dir/default.conf"
  if ! docker exec personal-assistant-router nginx -t >/dev/null; then
    mv "$router_dir/default.conf.previous" "$router_dir/default.conf"
    exit 1
  fi
  docker exec personal-assistant-router nginx -s reload
else
  mv "$router_dir/default.conf.next" "$router_dir/default.conf"
  docker run -d --name personal-assistant-router --restart unless-stopped --network "$network" \
    --memory 128m --memory-swap 128m --cpus 0.25 --pids-limit 128 \
    -v "$router_dir:/etc/nginx/conf.d:ro" nginx:1.27-alpine >/dev/null
fi

router_healthy=""
for _ in $(seq 1 20); do
  response="$(docker exec personal-assistant-router wget -qO- http://127.0.0.1:8787/api/health 2>/dev/null || true)"
  if grep -q '"ok":true' <<<"$response"; then router_healthy=yes; break; fi
  sleep 1
done
if [[ "$router_healthy" != yes ]]; then
  if [[ -f "$router_dir/default.conf.previous" ]]; then
    mv "$router_dir/default.conf.previous" "$router_dir/default.conf"
    docker exec personal-assistant-router nginx -s reload || true
  fi
  exit 1
fi

printf '%s\n' "$next" > "$active_file"
printf '%s\n' "$image" > "$router_dir/active-image"
if [[ -n "$previous" ]]; then
  printf '%s\n' "$previous" > "$router_dir/previous-slot"
  docker inspect --format '{{.Config.Image}}' "$previous_container" > "$router_dir/previous-image" 2>/dev/null || true
else
  printf 'legacy\n' > "$router_dir/previous-slot"
  docker inspect --format '{{.Config.Image}}' personal-assistant > "$router_dir/previous-image" 2>/dev/null || true
fi
sleep "${DRAIN_SECONDS:-20}"
if [[ -n "$previous_container" ]]; then
  docker stop --time 60 "$previous_container" >/dev/null || true
elif docker inspect personal-assistant >/dev/null 2>&1; then
  docker stop --time 60 personal-assistant >/dev/null || true
fi
printf 'active=%s image=%s previous=%s backup=%s\n' "$next" "$image" "${previous:-legacy}" "$backup_dir"
