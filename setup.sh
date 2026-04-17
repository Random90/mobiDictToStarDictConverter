#!/bin/sh
git config core.hooksPath .githooks
echo "Git hooks configured. Pre-commit hook will run build.js before each commit."

