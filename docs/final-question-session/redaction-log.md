# Redaction log

The transcript is published in full with one exception: credentials. Every
redaction is by pattern and counted below, so what was removed is auditable
even though the values are not. No message, turn or exchange was removed --
only secret values inside them.

**4 redactions** across 1527 Stage 2 records.

| pattern | occurrences |
|---|---|
| env assignment of a secret | 4 |

Replacement is the literal string `[REDACTED]`. For environment assignments the
variable name is preserved and only the value replaced, so a reader can see which
credential was configured without learning its value.

## Deliberately NOT redacted

`SEC_USER_AGENT` remains visible. SEC EDGAR requires every request to carry a
contact string of the form "Name email@domain" and rejects requests without one,
so it is a public identifier by design rather than a credential — it is sent to
sec.gov on every one of the 90 filings this dataset cites. It contains the
submitter's own name and email address, which the recipient of this submission
already holds. Redacting it would hide how the SEC channel identifies itself,
which is part of what makes those requests reproducible.

An adversarial scan of the published files was run against every value in the
local `.env`: 7 values checked, 0 credentials present in the output.
