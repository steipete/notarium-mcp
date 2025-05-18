#!/bin/bash

# IMPORTANT: This script must not output anything to stdout or stderr before the MCP server starts
# sending JSON-RPC messages. Any preliminary output can interfere with the MCP Inspector's ability
# to connect to or correctly parse messages from the server.
# For debugging this script itself, redirect echos to a temporary file, e.g.:
# echo "Checking path..." > /tmp/start_sh_debug.log

# Environment variables (like SIMPLENOTE_USERNAME, SIMPLENOTE_PASSWORD, LOG_LEVEL, LOG_FILE_PATH)
# are expected to be set by the calling environment (e.g., MCP Inspector UI).

# echo "MCP Notarium start.sh running... $(date)" # Silenced for MCP

# Get the directory where the script is located
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
# echo "SCRIPT_DIR (Project Root): ${SCRIPT_DIR}" # Silenced for MCP

# Change to the script's directory (project root)
cd "${SCRIPT_DIR}" || exit 1
# echo "Current directory after cd: $(pwd)" # Silenced for MCP

# Log file for start.sh debugging output (keep commented unless actively debugging start.sh itself)
# START_DEBUG_LOG="/tmp/notarium_start_debug.log"
# exec > >(tee -a "${START_DEBUG_LOG}") 2>&1
# echo "--- New start.sh execution $(date) ---" >> "${START_DEBUG_LOG}"

# Always attempt to run the compiled version from dist/
COMPILED_SERVER_PATH="dist/index.js"
ABSOLUTE_COMPILED_PATH="${SCRIPT_DIR}/${COMPILED_SERVER_PATH}"

# echo "Attempting to run compiled server: ${COMPILED_SERVER_PATH} (absolute: ${ABSOLUTE_COMPILED_PATH})" # Silenced

if [ -f "${ABSOLUTE_COMPILED_PATH}" ]; then
    # echo "Found compiled server. Running with node." # Silenced
    # Run the Node.js server; its stdout/stderr will be captured by MCP Inspector
    exec node "${COMPILED_SERVER_PATH}" # Use exec to replace shell process with node
else
    # These error messages go to stderr, which is acceptable for Inspector.
    echo "ERROR: Compiled server not found at ${ABSOLUTE_COMPILED_PATH}." >&2
    echo "Please run 'npm run build' to create the production build," >&2
    echo "or 'npm run dev' in a separate terminal to build and watch for changes." >&2
    exit 1
fi

# echo "MCP Notarium start.sh finished." # Silenced, exec above means this won't be reached anyway 