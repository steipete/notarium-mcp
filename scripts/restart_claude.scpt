property BUNDLE_ID : "com.anthropic.claudefordesktop"

on run
    try
        tell application id BUNDLE_ID
            if it is running then
                quit
                delay 2 -- Wait for app to quit
            end if
        end tell
    on error
        -- App wasn't running or error quitting, okay for this purpose
    end try
    delay 1 -- Ensure fully quit
    try
        tell application id BUNDLE_ID
            activate -- Relaunches and brings to front
        end tell
        delay 5 -- Allow time to launch and initialize
        return "Claude Desktop restarted."
    on error e
        return "Error restarting Claude: " & e
    end try
end run 