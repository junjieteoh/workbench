#!/bin/sh
# Configure the dedicated Ubuntu Workbench systemd user service. Run as the worker user.
set -eu
umask 077
project=${1:?pass a Google Cloud project ID}
location=${2:-global}
case "$project:$location" in *[!a-zA-Z0-9:.-]*) echo "Invalid project or location" >&2; exit 2;; esac
root="$HOME/workbench-happier"
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
unit=happier-daemon.workbench-tailnet.service
drop_dir="$HOME/.config/systemd/user/$unit.d"
config="$drop_dir/60-workbench-vertex.conf"
test -r "$HOME/.config/gcloud/application_default_credentials.json"
test -x "$root/happier"
systemctl --user is-active --quiet "$unit"
"$root/happier" install provider gemini
install -d -m 700 "$root/bin" "$root/state/gemini/.gemini" "$drop_dir"
install -m 700 "$source_dir/gemini" "$root/bin/workbench-gemini"
# Keep an operator's existing Gemini settings. New workers inherit the fork's model preset.
if [ ! -f "$root/state/gemini/.gemini/settings.json" ]; then
  install -m 600 "$source_dir/settings.json" "$root/state/gemini/.gemini/settings.json"
fi
candidate=$(mktemp "$drop_dir/.vertex.XXXXXX")
trap 'rm -f "$candidate"' EXIT
cat > "$candidate" <<EOF
[Service]
Environment="HAPPIER_GEMINI_PATH=%h/workbench-happier/bin/workbench-gemini"
Environment="HAPPIER_GEMINI_ACP_AUTH_METHOD=vertex-ai"
Environment="GEMINI_CLI_HOME=%h/workbench-happier/state/gemini"
Environment="WORKBENCH_VERTEX_ROOT=%h/workbench-happier"
Environment="WORKBENCH_VERTEX_ADC=%h/.config/gcloud/application_default_credentials.json"
Environment="WORKBENCH_VERTEX_PROJECT=$project"
Environment="WORKBENCH_VERTEX_LOCATION=$location"
EOF
if ! cmp -s "$candidate" "$config"; then
  mv "$candidate" "$config"
  systemctl --user daemon-reload
  systemctl --user restart "$unit"
fi
systemctl --user is-active "$unit"
