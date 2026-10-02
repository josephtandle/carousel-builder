#!/usr/bin/env bash
# Carousel Builder installer.
# Creates the data dir, copies the example configs into it (never overwriting
# yours), links the `carousel` command and prints what to do next.
#
# Environment:
#   CAROUSEL_HOME      data dir (default: .carousel in the folder you run this from)
#   CAROUSEL_BIN_DIR   where to link the command (default: $HOME/.local/bin)
#   CAROUSEL_SKIP_LINK set to 1 to skip linking the command
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${CAROUSEL_HOME:-$PWD/.carousel}"
BIN_DIR="${CAROUSEL_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "Node.js is not installed. Install Node 18 or newer, then run this again."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "Node $(node -v) is too old. Carousel Builder needs Node 18 or newer."
  exit 1
fi

say "Engine:   $ENGINE_DIR"
say "Data dir: $DATA_DIR"
for sub in drafts exports library logs; do
  mkdir -p "$DATA_DIR/$sub"
done

for name in brand providers publishers; do
  example="$ENGINE_DIR/config/$name.example.json"
  target="$DATA_DIR/$name.json"
  if [ -L "$target" ]; then
    # Never write through a symlink: it could point anywhere.
    say "  kept    $name.json (it is a symlink, left untouched)"
  elif [ -e "$target" ]; then
    say "  kept    $name.json (already yours)"
  elif [ -f "$example" ]; then
    cp "$example" "$target"
    say "  created $name.json"
  else
    say "  skipped $name.json (no example shipped)"
  fi
done

chmod +x "$ENGINE_DIR/bin/carousel.js"
LINKED=0
if [ "${CAROUSEL_SKIP_LINK:-0}" = "1" ]; then
  say "Command link skipped (CAROUSEL_SKIP_LINK=1)."
else
  mkdir -p "$BIN_DIR"
  link="$BIN_DIR/carousel"
  want="$ENGINE_DIR/bin/carousel.js"
  if [ -L "$link" ]; then
    # Only a link that already points at this engine is refreshed. A link that
    # belongs to something else is never replaced.
    if [ "$(readlink "$link")" = "$want" ]; then
      LINKED=1
      say "The carousel command is already linked in $BIN_DIR"
    else
      say "A carousel link in $BIN_DIR points somewhere else ($(readlink "$link")), so it was left alone."
      say "Remove it yourself if you want this engine there, or set CAROUSEL_BIN_DIR to another folder."
    fi
  elif [ -e "$link" ]; then
    say "A file named carousel already exists in $BIN_DIR and is not a link, so it was left alone."
  else
    ln -s "$want" "$link"
    LINKED=1
    say "Linked the carousel command into $BIN_DIR"
  fi
fi

RUN="node \"$ENGINE_DIR/bin/carousel.js\""
if [ "$LINKED" = "1" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) RUN="carousel" ;;
    *) say "Note: $BIN_DIR is not on your PATH. Add it, or run the command as: $RUN" ;;
  esac
fi

say ""
say "Setup check:"
CAROUSEL_HOME="$DATA_DIR" node "$ENGINE_DIR/bin/carousel.js" doctor || true

say ""
say "Next steps:"
say "  1. Keep one data dir from anywhere:  export CAROUSEL_HOME=\"$DATA_DIR\""
say "  2. Make it yours:                    edit $DATA_DIR/brand.json (name, colours, logo)"
say "  3. Draft a deck:                     $RUN draft \"what the carousel is about\""
say "  4. Render it:                        $RUN render <id from step 3>"
say "  5. See what publishing would send:   $RUN publish <id> --to linkedin   (a dry run: it prints a confirm token)"
say "  6. Publish for real:                 add --confirm PUBLISH --confirm-token <token> (after setting that platform's tokens in your environment)"
say ""
say "Or do all of it in your browser:       $RUN ui"
say ""
say "Nothing leaves this machine until you set a provider key or a publisher token and confirm a publish."
