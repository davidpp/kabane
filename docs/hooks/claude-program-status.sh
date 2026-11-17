#!/bin/sh
# Reports Claude Code's state through OSC 7501 from its own hook events, for the runs whose
# startup probe timed out and so never report (docs/recipes.md, "When a Claude Code run stays
# live"). A stopgap: remove it once Claude Code fixes the probe
# (anthropics/claude-code#105534, #103022).
#
# usage: claude-program-status.sh <state> [kind]   (the hook's JSON arrives on stdin)

cat >/dev/null

record="state=$1"
[ -n "${2:-}" ] && record="$record:kind=$2"

# A hook has no controlling terminal, so /dev/tty fails: write to the tty of the nearest
# ancestor that has one, which is Claude Code's.
pid=$PPID
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
	tty=$(ps -o tty= -p "$pid" | tr -d ' ')
	case "$tty" in
	"" | "?" | "??") pid=$(ps -o ppid= -p "$pid" | tr -d ' ') ;;
	*)
		printf '\033]7501;%s:app=claude-code\033\\' "$record" >"/dev/$tty"
		exit 0
		;;
	esac
done
exit 0
