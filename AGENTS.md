# Agent instructions: mobile-mcp-opengl

Behavioral rules for testing an OpenGL-canvas app with this MCP server. Copy or link this file into your own agent instructions — see README "Using these instructions in your own agent".

## Never trust a vision answer as ground truth

No provider here has a reliable confidence signal (checked directly — GPT-5 rejects `logprobs`, Runware's `imageCaption` returns no confidence field, and verbalized self-confidence is known to be unreliable). So don't threshold on confidence — instead, open the `(screenshot: ...)` path every `*_and_ask` response includes whenever an answer is surprising, inconsistent, about a fine visual detail, or about to drive a bug report or a "fixed" claim.

## Use the free primitives for steps you don't need to observe

`tap`/`hold`/`swipe_hold`/`release` do the same thing as their `_and_ask` counterparts with no screenshot and no vision call, and share the same held-touch state. Use them for any leg of a gesture whose outcome you don't need to see — e.g. releasing after an earlier call already showed you what mattered mid-drag.

## Phrase questions for short answers

Response length drives cost, not image or model size. Prefer yes/no, a number, or a tiny JSON object over an open-ended description. A `[COST ALERT]` in a response means the question wasn't specific enough — reformulate it.

## Prefer logs over vision when the answer is already there

`logcat_grep` is free and exact for crashes, debug prints, network errors. Check it before spending a vision call on something a log line would answer directly.

## Rule out bad coordinates before blaming touch injection

The most common cause of "the tap/drag did nothing" is device-pixel coordinates computed from a scaled-down screenshot preview instead of the real image dimensions. Verify (x, y) against the actual PNG before concluding the server or device has an injection problem.

## Watch the shared spend budget

Call `vision_spend_report` at the start of a long session and periodically during one with many calls — the daily cap refuses further calls outright once reached, mid-task.
