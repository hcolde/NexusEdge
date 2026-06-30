# Security Policy

## Supported Versions

NexusEdge is pre-1.0. Security fixes are applied to the current `main` branch and the latest published release.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a Vulnerability

Please report security issues through GitHub private vulnerability reporting when available, or by opening a minimal public issue if the finding does not expose exploit details.

Include:

- affected version or commit;
- affected file, API, or runtime path;
- impact and expected exploit conditions;
- a minimal reproduction or proof sketch;
- recommended fix if known.

Do not include secrets, live credentials, or private endpoint details in reports.

## Security Scope

The runtime is designed for edge environments and intentionally avoids:

- Node.js runtime APIs;
- filesystem access;
- dynamic code execution;
- SDK runtime dependencies;
- unbounded provider response parsing.

Security reports are especially useful around prompt/data isolation, tool input validation, stream parsing, provider response limits, and hidden-agent output boundaries.
