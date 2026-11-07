#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  printf '%s\n' 'Usage: run-resident.sh /absolute/node /absolute/dsh-home profile /absolute/patch.yml port' >&2
  exit 64
fi

node_path=$1
resident_home=$2
profile_name=$3
profile_patch=$4
listen_port=$5
for path in "$node_path" "$resident_home" "$profile_patch"; do
  case "$path" in
    /*) ;;
    *) printf '%s\n' 'Node, DSH home and the profile overlay require absolute paths.' >&2; exit 64 ;;
  esac
done
case "$profile_name" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) printf '%s\n' 'Invalid named DSH profile.' >&2; exit 64 ;;
esac
case "$listen_port" in
  ''|*[!0-9]*|??????*) printf '%s\n' 'Invalid loopback port.' >&2; exit 64 ;;
esac
[ "$listen_port" -le 65535 ] || exit 64

if [ ! -x "$node_path" ] || [ ! -r "$profile_patch" ] || [ ! -d "$resident_home/profiles/$profile_name" ]; then
  printf '%s\n' 'The Node executable, prepared named profile, or profile overlay is unavailable.' >&2
  exit 66
fi

deploy_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
dsh_entry="$deploy_dir/../node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -r "$dsh_entry" ]; then
  printf '%s\n' 'Install the pinned dshpa workspace before starting the resident host.' >&2
  exit 66
fi

umask 077
export DSH_HOME="$resident_home" DSH_PERMISSION_MODE=workspace-write DSH_TELEMETRY_DISABLED=1 DSHPA_RESIDENT=1
# Keep native private output and process bootstrap credentials out of service logs.
exec "$node_path" "$dsh_entry" --profile "$profile_name" --patch "$profile_patch" \
  --patch "$deploy_dir/resident.patch.yml" --host 127.0.0.1 --port "$listen_port" --no-open >/dev/null 2>&1
