#!/bin/bash
# Double-click this file in Finder to start the poll bot in a Terminal window.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (version 24 or newer), then try again."
  read -r -p "Press Enter to close this window. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing what the bot needs (this takes a minute)..."
  npm install || { read -r -p "Installation failed. Press Enter to close this window. "; exit 1; }
  npx playwright install chromium || { read -r -p "Browser download failed. Press Enter to close this window. "; exit 1; }
fi

npm start
echo
read -r -p "The bot has stopped. Press Enter to close this window. "
