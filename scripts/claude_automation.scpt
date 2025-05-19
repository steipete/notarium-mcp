property BUNDLE_ID : "com.anthropic.claudefordesktop"
property APP_NAME : "Claude"
property DEFAULT_WAIT : 15 -- seconds to wait for Claude to respond after sending prompt

--
-- Main entry point. Accepts two positional arguments when run via osascript:
--   1. Prompt text to send to Claude
--   2. (optional) Wait time in seconds before capturing output (defaults to DEFAULT_WAIT)
--
on run argv
    if (count of argv) < 1 then
        return "Usage: osascript claude_automation.scpt <prompt text> [waitSeconds]"
    end if

    set thePrompt to item 1 of argv as text
    set waitSecs to DEFAULT_WAIT
    if (count of argv) ≥ 2 then
        try
            set waitSecs to (item 2 of argv) as integer
        on error
            set waitSecs to DEFAULT_WAIT -- fallback if parsing fails
        end try
    end if

    -- Step 1: Restart Claude to ensure fresh tool schema
    set restartResult to my restartClaude()
    -- Step 2: Send the prompt
    set sendResult to my sendPromptToClaude(thePrompt)
    -- Step 3: Wait for Claude to generate the response
    delay waitSecs
    -- Step 4: Capture screenshot & clipboard
    set screenshotPath to my captureScreenshot()
    set convoText to my copyConversationToClipboard()

    -- Assemble human-readable summary (JSON-ish) to help callers parse
    set summary to "{\n  \"prompt\": " & my quoted(thePrompt) & ",\n  \"restart_status\": " & my quoted(restartResult) & ",\n  \"send_status\": " & my quoted(sendResult) & ",\n  \"screenshot\": " & my quoted(screenshotPath) & ",\n  \"clipboard_text\": " & my quoted(convoText) & "\n}"
    return summary
end run

--
-- Gracefully restarts Claude Desktop so it reloads MCP tool schemas.
-- Returns a short status string.
--
on restartClaude()
    try
        tell application id BUNDLE_ID
            if it is running then
                quit
                repeat 20 times -- wait up to 10 seconds until fully quits
                    if it is running then
                        delay 0.5
                    else
                        exit repeat
                    end if
                end repeat
            end if
        end tell
    on error errMsg
        -- Quitting might fail – we ignore because we'll relaunch anyway
    end try

    -- Launch / activate fresh instance
    try
        tell application id BUNDLE_ID to activate
        delay 5 -- allow Electron app to finish booting
        return "restarted"
    on error errMsg
        return "restart_error: " & errMsg
    end try
end restartClaude

--
-- Sends `thePrompt` to Claude's input field.
-- Assumes the app is running and frontmost.
-- Returns status string.
--
on sendPromptToClaude(thePrompt)
    try
        -- Focus Claude using System Events
        tell application "System Events"
            set claudeProc to first process whose bundle identifier is BUNDLE_ID
            set frontmost of claudeProc to true
            delay 0.3
            -- Clear any existing text (Cmd+A then Delete)
            keystroke "a" using {command down}
            delay 0.2
            key code 51 -- Delete key
            delay 0.2
            -- Type the prompt
            keystroke thePrompt
            delay 0.2
            -- Send with Cmd+Return
            keystroke return using {command down}
        end tell
        return "sent"
    on error errMsg
        return "send_error: " & errMsg
    end try
end sendPromptToClaude

--
-- Captures a screenshot of the frontmost Claude window and returns the file path.
--
on captureScreenshot()
    try
        -- Determine window bounds
        tell application "System Events"
            set claudeProc to first process whose bundle identifier is BUNDLE_ID
            tell claudeProc to set {xPos, yPos} to position of front window
            tell claudeProc to set {wSize, hSize} to size of front window
        end tell
        -- Build path on Desktop
        set timeStamp to do shell script "date '+%Y%m%d_%H%M%S'"
        set screenPath to POSIX path of (path to desktop folder) & "claude_" & timeStamp & ".png"
        -- Capture region
        do shell script "screencapture -R" & xPos & "," & yPos & "," & wSize & "," & hSize & " " & quoted form of screenPath
        return screenPath
    on error errMsg
        return "screenshot_error: " & errMsg
    end try
end captureScreenshot

--
-- Copies whole conversation to clipboard and returns its content.
--
on copyConversationToClipboard()
    try
        tell application "System Events"
            keystroke "a" using {command down}
            delay 0.3
            keystroke "c" using {command down}
        end tell
        delay 0.3
        set convoText to the clipboard as text
        return convoText
    on error errMsg
        return "clipboard_error: " & errMsg
    end try
end copyConversationToClipboard

-- Utility: proper quoting for JSON string output
on quoted(theText)
    set AppleScript's text item delimiters to "\\\""
    set escaped to "\\\"" & theText & "\\\""
    set AppleScript's text item delimiters to ""
    return escaped
end quoted 