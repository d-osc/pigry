#!/bin/sh
set -eu

case "${1-}" in
  -h|--help)
    printf 'Usage: pigry [folder]\n'
    exit 0
    ;;
  --|--open-folder)
    shift
    if [ "$#" -ne 1 ]; then
      printf 'Usage: pigry [folder]\n' >&2
      exit 2
    fi
    ;;
esac

if [ "$#" -eq 0 ]; then
  exec /usr/bin/open -n -b com.pigry.app
fi
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf 'Usage: pigry [folder]\n' >&2
  exit 2
fi

case "$1" in
  /*) folder=$1 ;;
  *) folder=$PWD/$1 ;;
esac
exec /usr/bin/open -n -b com.pigry.app --args --open-folder "$folder"
