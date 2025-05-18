#!/bin/bash

# IMPORTANT: This script must not output anything to stdout or stderr before the MCP server starts
# sending JSON-RPC messages. Any preliminary output can interfere with the MCP Inspector's ability
# to connect to or correctly parse messages from the server.
# For debugging this script, redirect echos to a temporary file, e.g.:
# echo "Checking path..." > /tmp/start_sh_debug.log

# Environment variables (like SIMPLENOTE_USERNAME, SIMPLENOTE_PASSWORD, LOG_LEVEL, LOG_FILE_PATH)
# are expected to be set by the calling environment (e.g., MCP Inspector UI).

LOG_FILE="/tmp/notarium_start_debug.log"
rm -f "$LOG_FILE" # Clear previous log
echo "MCP Notarium start.sh running... $(date)" >> "$LOG_FILE"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
echo "SCRIPT_DIR (Project Root): $SCRIPT_DIR" >> "$LOG_FILE"
cd "$SCRIPT_DIR" # Ensure we are in the project root where start.sh is
echo "Current directory after cd: $(pwd)" >> "$LOG_FILE"

# Paths are now relative to SCRIPT_DIR (project root)
DIST_SERVER_JS="dist/index.js"
SRC_SERVER_TS="src/index.ts"

echo "Checking for compiled server: $DIST_SERVER_JS (absolute: $SCRIPT_DIR/$DIST_SERVER_JS)" >> "$LOG_FILE"
ls -al "$SCRIPT_DIR/dist" >> "$LOG_FILE" 2>&1 # Check content of dist, redirect ls stderr to log too
ls -al "$SCRIPT_DIR/$DIST_SERVER_JS" >> "$LOG_FILE" 2>&1
if [ -f "$DIST_SERVER_JS" ]; then
    echo "Found compiled server. Running with node." >> "$LOG_FILE"
    node "$DIST_SERVER_JS"
    exit $?
else
    echo "Compiled server $DIST_SERVER_JS NOT found." >> "$LOG_FILE"
fi

echo "Checking for TypeScript source: $SRC_SERVER_TS (absolute: $SCRIPT_DIR/$SRC_SERVER_TS)" >> "$LOG_FILE"
ls -al "$SCRIPT_DIR/src" >> "$LOG_FILE" 2>&1 # Check content of src
ls -al "$SCRIPT_DIR/$SRC_SERVER_TS" >> "$LOG_FILE" 2>&1
if [ -f "$SRC_SERVER_TS" ]; then
    echo "Found TypeScript source. Attempting to run with npx tsx..." >> "$LOG_FILE"
    npx tsx "$SRC_SERVER_TS"
    TSX_EXIT_CODE=$?
    echo "npx tsx completed with exit code: $TSX_EXIT_CODE" >> "$LOG_FILE"
    exit $TSX_EXIT_CODE
else
    echo "TypeScript source $SRC_SERVER_TS NOT found." >> "$LOG_FILE"
fi

echo "Error: Server entry point not found after all checks." >> "$LOG_FILE"
exit 1 