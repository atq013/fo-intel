# Redaction log — review session

The session is published in full with one exception: credentials. Every
redaction is by pattern and counted below, so what was removed is auditable
even though the values are not. No message, turn or exchange was removed --
only secret values inside them.

**7 redactions** across 565 records.

| pattern | occurrences |
|---|---|
| env assignment of a secret | 6 |
| Companies House key (uuid form) | 1 |

Replacement is the literal string `[REDACTED]`. For environment assignments the
variable name is preserved and only the value replaced, so a reader can see which
credential was configured without learning its value.

The same patterns are used by the Stage 2 deliverable-9 exporter
(`packages/pipeline/src/jobs/export-ai-session.ts`); they are reproduced here
rather than reused so that the repository's own script stayed unmodified during
a review whose terms were to change nothing.
