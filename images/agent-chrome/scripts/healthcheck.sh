#!/bin/sh
curl -sf http://127.0.0.1:${CDP_PORT:-9222}/json/version > /dev/null 2>&1
