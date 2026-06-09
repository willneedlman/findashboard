#!/bin/sh
cd "$(dirname "$0")" && fly deploy --config fly.toml "$@"
