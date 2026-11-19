set -eu
umask 077

printf 'PIGRY_BOOTSTRAP 1 %s %s\n' "$(uname -s)" "$(uname -m)"
command -v git >/dev/null || { printf 'Git is required on the SSH server.\n' >&2; exit 1; }
IFS=' ' read -r digest size
case "$digest" in *[!0-9a-f]*|'') exit 1;; esac
case "$size" in *[!0-9]*|'') exit 1;; esac
[ "${#digest}" -eq 64 ] && [ "$size" -le 67108864 ] || exit 1

cache="${XDG_DATA_HOME:-$HOME/.local/share}/pigry/server"
mkdir -p -- "$cache"
server="$cache/$digest"
if [ -x "$server" ] && printf '%s  %s\n' "$digest" "$server" | sha256sum --status -c; then
  printf 'PIGRY_CACHED\n'
else
  temporary=$(mktemp "$cache/.install.XXXXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'PIGRY_UPLOAD\n'
  head -c "$size" > "$temporary"
  if ! printf '%s  %s\n' "$digest" "$temporary" | sha256sum --status -c; then
    printf 'PIGRY Server checksum verification failed.\n' >&2
    exit 1
  fi
  chmod 700 "$temporary"
  mv -f -- "$temporary" "$server"
  trap - EXIT HUP INT TERM
fi
exec "$server"
