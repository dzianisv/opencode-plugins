#!/bin/bash
# Manual test for Esc Abort Race Condition (Issue #18)
#
# INSTRUCTIONS:
# 1. Run this script
# 2. When the agent starts working, press Esc to abort
# 3. Check the output - reflection should NOT inject feedback
#
# EXPECTED: After Esc, you should see:
#   [Reflection] SKIP: session was recently aborted (Esc)
#
# FAILURE: If you see reflection feedback injected after abort,
#   the fix is not working.

set -e

echo "=== Manual Test: Esc Abort Race Condition ==="
echo ""
echo "INSTRUCTIONS:"
echo "1. Wait for agent to start working"
echo "2. Press Esc to abort"
echo "3. Watch for '[Reflection] SKIP: session was recently aborted'"
echo ""
echo "Starting in 3 seconds..."
sleep 3

# Create temp directory
TESTDIR=$(mktemp -d)
cd "$TESTDIR"
echo "Test directory: $TESTDIR"

# Run opencode with debug logging
echo ""
echo "=== Starting OpenCode with REFLECTION_DEBUG=1 ==="
echo ""

REFLECTION_DEBUG=1 opencode run "Write a very long story about a dragon. Make it at least 500 words." 2>&1 | tee /tmp/abort-test.log &
PID=$!

echo ""
echo "OpenCode started with PID $PID"
echo "Press Esc NOW to abort and test the fix!"
echo ""

# Wait for user to abort or task to complete
wait $PID 2>/dev/null || true

echo ""
echo "=== Test Complete ==="
echo ""

# Check logs for expected behavior
if grep -q "SKIP: session was recently aborted" /tmp/abort-test.log; then
    echo "✓ SUCCESS: Abort was detected and reflection was skipped"
elif grep -q "## Reflection:" /tmp/abort-test.log; then
    echo "✗ FAILURE: Reflection feedback was injected after abort!"
    echo "  The fix is NOT working correctly."
    exit 1
else
    echo "? INCONCLUSIVE: Could not determine outcome"
    echo "  Check /tmp/abort-test.log manually"
fi

# Cleanup
rm -rf "$TESTDIR"
