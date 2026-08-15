#!/usr/bin/env bash
set -euo pipefail

root="${PERSONAL_ASSISTANT_ROOT:-/opt/personal-assistant}"
deploy_dir="$root/deploy-blue-green"
router_dir="$root/router"
previous="$(cat "$router_dir/previous-slot")"
if [[ "$previous" == legacy ]]; then previous_container="personal-assistant"; else previous_container="personal-assistant-$previous"; fi

docker start "$previous_container" >/dev/null
if [[ "$previous" == legacy ]]; then
  ready=""
  for _ in $(seq 1 60); do
    response="$(docker exec "$previous_container" node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>console.log(await r.text())).catch(()=>process.exit(1))" 2>/dev/null || true)"
    if grep -q '"ok":true' <<<"$response"; then ready=yes; break; fi
    sleep 2
  done
  [[ "$ready" == yes ]]
else
  for _ in $(seq 1 60); do
    [[ "$(docker inspect --format '{{.State.Health.Status}}' "$previous_container" 2>/dev/null || true)" == healthy ]] && break
    sleep 2
  done
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$previous_container")" == healthy ]]
fi
sed "s/__UPSTREAM__/$previous_container/g" "$deploy_dir/router/default.conf.template" > "$router_dir/default.conf.next"
cp "$router_dir/default.conf" "$router_dir/default.conf.rollback"
mv "$router_dir/default.conf.next" "$router_dir/default.conf"
if ! docker exec personal-assistant-router nginx -t >/dev/null; then
  mv "$router_dir/default.conf.rollback" "$router_dir/default.conf"
  exit 1
fi
docker exec personal-assistant-router nginx -s reload
printf '%s\n' "$previous" > "$router_dir/active-slot"
printf 'rolled_back_to=%s\n' "$previous"
