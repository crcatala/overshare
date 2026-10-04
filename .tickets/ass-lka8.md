---
id: ass-lka8
status: closed
deps: []
links: []
created: 2026-10-03T23:27:56Z
type: bug
priority: 4
assignee: cc-vps
tags: [redact, viewer]
---
# redact: two different secret-shaped response ids collapse to one [REDACTED:rule] token, so the viewer can link both to the first step

Follow-up from ass-1c07 review. Since ass-1c07 a secret-shaped step responseId / responses[].id is redacted instead of blocking the share. Two distinct such ids in one session both become the same [REDACTED:<rule>] token, and viewer/src/transcript.ts (responseId -> step map, first wins) attributes the second response's usage to the first step. Display only, no leak, and it needs several unusual secret-shaped ids in one session; before ass-1c07 such a share was blocked outright. Fix direction: a per-Redactor surrogate (stable index per distinct value, e.g. [REDACTED:rule#2]) used by redactIdentifier, applied consistently to step.responseId, toolGroup.responseIds and responses[].id.

## Acceptance Criteria

Two distinct secret-shaped response ids in one session stay distinguishable in the payload without exposing either value; the viewer links each response to its own step; covered by a test for both harnesses.

