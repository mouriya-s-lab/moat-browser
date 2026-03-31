#!/bin/sh
curl -sf http://localhost:8080/api/health > /dev/null 2>&1 || \
  curl -sf http://localhost:8080/ > /dev/null 2>&1
