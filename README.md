# DSH Connect Lingxi

DSH Desktop provider adapter for WPS Lingxi (local 0.5.0 source snapshot).

## Features
- Model catalog and WPS Lingxi cowork streaming provider integration.
- DSH-native tool-call blocks from host-visible tool schemas and model tool-call envelopes.
- Permission and command execution remain the responsibility of DSH host.
- Structured tool results are forwarded into the next conversation turn.
- Error finishes always return a nonempty `failure.code`; no cloud sandbox action is treated as an authorized local execution.

## Tests
Run `npm test` for offline tests. `npm run test:machine` performs environment-dependent credential/SQLite tests and may require WPS installation, login and a supported Node.js version.

## Security
See [SECURITY.md](SECURITY.md). Local sessions, logs, archives, evidence and user-specific paths are intentionally excluded.

## Note
WPS upstream behavior varies; tool-call compatibility is verified with offline fixtures. Production DSH permission approval and execution must be validated separately.
