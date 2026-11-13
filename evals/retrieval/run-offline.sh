#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s /path/to/venv/bin/python /path/to/assets /path/to/new-report-directory\n' "$0" >&2
  exit 2
}

[[ $# == 3 && $1 == /* && $2 == /* && $3 == /* ]] || usage
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
python_directory=$(cd -- "$(dirname -- "$1")" && pwd -P)
python="$python_directory/$(basename -- "$1")"
assets=$(cd -- "$2" && pwd -P)
reports=$(realpath -m -- "$3")
node=$(type -P node)
bwrap=$(type -P bwrap)
ip=$(type -P ip)

[[ -x $python && -f $python_directory/../pyvenv.cfg ]] || {
  printf 'Use the Python executable from the pinned evaluation virtual environment.\n' >&2
  exit 2
}
[[ -f $assets/model.onnx && -f $assets/tokenizer.json ]] || {
  printf 'Supply the directory with the model and tokenizer from assets.json.\n' >&2
  exit 2
}
[[ -f $repository/node_modules/vitest/vitest.mjs && -d $repository/packages/personal-agent/lib ]] || {
  printf 'Build the repository and install its pinned dependencies before replay.\n' >&2
  exit 2
}

umask 077
mkdir -- "$reports"
# Keep temporary input locations visible through the private scratch mounts.
mounts=()
for path in "$repository" "$python_directory/.." "$assets" "$(dirname -- "$node")"; do
  path=$(realpath -- "$path")
  case "$path" in
    /tmp/*|/run/*|/var/tmp/*) mounts+=(--ro-bind "$path" "$path") ;;
  esac
done

exec "$bwrap" --unshare-user --uid "$(id -u)" --gid "$(id -g)" --unshare-net \
  --unshare-ipc --unshare-pid --cap-add CAP_NET_ADMIN --die-with-parent --new-session \
  --ro-bind / / --ro-bind /dev /dev --proc /proc --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run \
  "${mounts[@]}" --bind "$reports" "$reports" --chdir "$repository" --clearenv \
  --setenv PATH "$(dirname -- "$node"):/usr/bin:/bin" --setenv LANG C.UTF-8 \
  --setenv HOME /tmp/home --setenv TMPDIR /tmp/work \
  --setenv XDG_CACHE_HOME /tmp/cache --setenv XDG_CONFIG_HOME /tmp/config \
  --setenv XDG_DATA_HOME /tmp/data --setenv XDG_STATE_HOME /tmp/state \
  --setenv XDG_RUNTIME_DIR /tmp/runtime --setenv GIT_OPTIONAL_LOCKS 0 \
  /bin/bash -euo pipefail -c '
    python=$1 assets=$2 reports=$3 node=$4 ip=$5
    mkdir -- "$HOME" "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
    "$ip" link set lo up
    lexical() {
      DSHPA_SEMANTIC_CORPUS=$2 DSHPA_SEMANTIC_LEXICAL_REPORT=$reports/$1-lexical.json \
        "$node" node_modules/vitest/vitest.mjs run tests/e2e/semantic-retrieval.spec.ts
    }
    directory=$PWD/evals/retrieval
    corpus=$directory/semantic-calibration.json
    lexical calibration "$corpus"
    "$python" -I -B "$directory/score.py" calibrate "$corpus" "$reports/calibration-lexical.json" \
      "$assets" "$reports/policy.json"

    for name in holdout original keyword-navigation natural final-natural; do
      if [[ $name == holdout ]]; then
        corpus=$directory/semantic-holdout.json
      else
        corpus=$PWD/tests/e2e/fixtures/knowledge-retrieval/$name.json
      fi
      lexical "$name" "$corpus"
      "$python" -I -B "$directory/score.py" evaluate "$corpus" "$reports/$name-lexical.json" \
        "$assets" "$reports/$name-semantic.json" --policy "$reports/policy.json"
    done
  ' bash "$python" "$assets" "$reports" "$node" "$ip"
