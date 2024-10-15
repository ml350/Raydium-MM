#!/bin/bash

while true; do
  echo "Starting Volume Bot at $(date)..."
  
  # Run your script with ts-node
  npm run start
  
  # Capture exit code for logging
  EXIT_CODE=$?
  echo "Process exited with code $EXIT_CODE at $(date). Restarting in 5 seconds..."

  # Optional: Exit on a specific exit code (if needed)
  if [ $EXIT_CODE -eq 0 ]; then
    echo "Clean exit detected. Restarting..."
  fi

  # Wait before restarting
  sleep 5
done
