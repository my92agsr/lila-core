#!/bin/bash
# Send a message to your Telegram bot from the shell.
# Usage: ./scripts/notify.sh "Your message here"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found at $ENV_FILE"
  exit 1
fi

# Read values from .env
TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)
ALLOWED_CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2-)

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env"
  exit 1
fi

if [ -z "$ALLOWED_CHAT_ID" ]; then
  echo "Error: ALLOWED_CHAT_ID not set in .env"
  exit 1
fi

MESSAGE="${1:-No message provided}"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${ALLOWED_CHAT_ID}" \
  -d "text=${MESSAGE}" \
  -d "parse_mode=HTML" > /dev/null

if [ $? -eq 0 ]; then
  echo "Message sent."
else
  echo "Failed to send message."
  exit 1
fi
