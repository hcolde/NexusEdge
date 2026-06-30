# Contributing

Thank you for helping improve NexusEdge.

## Development Setup

```sh
npm ci
npm run ci
```

The runtime library must stay compatible with edge runtimes. Source files under `src/` must not use Node.js runtime APIs, filesystem access, dynamic code execution, or runtime dependencies.

## Pull Request Checklist

- Keep changes focused and small.
- Add or update tests for behavior changes.
- Run `npm run ci` before opening a pull request.
- Update `README.md` or examples when public API behavior changes.
- Avoid adding runtime dependencies unless there is a strong edge-runtime reason.

## Project Constraints

NexusEdge prioritizes:

- zero runtime dependencies;
- native `fetch`, Web Streams, and SSE;
- deterministic DAG/FSM orchestration before LLM routing;
- bounded parsing and output handling;
- explicit separation between trusted instructions and untrusted model/tool data.

## Release Checklist

Before publishing a release:

```sh
npm run ci
npm run benchmark
npm pack --dry-run
```

Then create a Git tag and GitHub release from `main`.
