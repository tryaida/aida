# Security

AIDA drives a real browser against your app, reads your app's environment files to check its
database, and publishes what it captures. Problems in any of that matter to us.

## Reporting a vulnerability

Please report privately through GitHub:
[Report a vulnerability](https://github.com/tryaida/aida/security/advisories/new). Don't open a
public issue for a security problem.

Say what you found, how to reproduce it, and what it lets someone do. We'll reply within a week
and keep you posted until it's fixed. We're happy to credit you in the fix unless you'd rather we
didn't.

## What counts

Anything that gets around AIDA's safety checks, for example:

- capture, inspect or CI writing to a database that isn't local or a throwaway you named
- real email, SMS or payments going out during a capture
- personal data or secrets reaching a published page, screenshot, video, PDF or the search index
- the Studio accepting edits from another site, or being reachable when it shouldn't be
- the help chat or agent connector leaking keys or content that isn't published
- an agent approving the first production publish on its own
- CI running fork code with secrets or write access

The safety defaults are described in [docs/setup.md](docs/setup.md#safety-defaults).

## Versions

AIDA is pre-release. Fixes go into the latest version on `main`; older versions aren't patched.
