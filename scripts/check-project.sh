#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_step() {
  local label="$1"
  shift
  printf '\n[%s]\n' "$label"
  "$@"
}

verify_deploy_guards() {
  if bash deploy/build-and-deploy.sh >/dev/null 2>&1; then
    printf 'Legacy deploy unexpectedly accepted an empty target.\n' >&2
    return 1
  fi
  if DEPLOY_SERVER=root@8.217.244.181 bash deploy/build-and-deploy.sh >/dev/null 2>&1; then
    printf 'Legacy deploy unexpectedly accepted the retired host.\n' >&2
    return 1
  fi
  if DEPLOY_SERVER=root@47.243.128.151 bash deploy/build-and-deploy.sh >/dev/null 2>&1; then
    printf 'Legacy deploy unexpectedly accepted the ingress-only host.\n' >&2
    return 1
  fi
}

verify_flutterfire_config() {
  node -e '
    const fs = require("node:fs");
    const path = "flutter_app/firebase.json";
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const ios = config?.flutter?.platforms?.ios?.default;
    if (!ios?.projectId || !ios?.appId || ios.fileOutput !== "ios/Runner/GoogleService-Info.plist") {
      throw new Error(`${path} is missing the required iOS FlutterFire configuration`);
    }
  '
}

cd "$project_root"

run_step "Shell syntax" bash -n \
  scripts/check-project.sh \
  deploy/build-and-deploy.sh \
  deploy/deploy-mac-production.sh \
  deploy/rollback-mac-production.sh \
  deploy/switch-blue-green.sh \
  deploy/rollback-blue-green.sh
run_step "Web build" npm run build
run_step "Node dependency audit" npm audit
run_step "Deployment safety guards" verify_deploy_guards
run_step "FlutterFire configuration" verify_flutterfire_config
run_step "Worker tests" npm run test:worker
run_step "Python and QQ integration tests" npm run test:python

run_step "Server build" npm --prefix server run build
run_step "Server tests" npm --prefix server test
run_step "Server production dependency audit" npm --prefix server audit --omit=dev

run_step "Flutter analyze" bash -lc 'cd "$1/flutter_app" && flutter analyze' _ "$project_root"
run_step "Flutter tests" bash -lc 'cd "$1/flutter_app" && flutter test' _ "$project_root"

printf '\nAll project checks passed.\n'
