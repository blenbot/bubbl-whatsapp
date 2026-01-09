#!/usr/bin/env bash

cd "$HOME/Desktop/bubbl-whatsapp" || { echo "Project folder not found"; exit 1; }

PID=$(sudo lsof -ti tcp:3001)
if [ -n "${PID}" ]; then
  echo "Killing process(es) on port 3001: ${PID}"
  echo "${PID}" | xargs sudo kill -9
fi

echo "Installing dependencies..."
npm ci

echo "Starting WhatsApp server on port 3001..."
npm start
