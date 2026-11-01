# Claude Code instructions for OpsMemory

@AGENTS.md

## Build-time memory (Meko)

Claude Code's own project memory lives in the Meko datapack **`opsmemory-build`** (see docs/MEKO_USAGE.md).

- **Before significant implementation work**, recall relevant context from `opsmemory-build` (`context_search` or `memory_search` with that datapack's `datapack_id`): architecture decisions, constraints, known bugs, conventions.
- **After meaningful work**, record new decisions and lessons there with `memory_add`, one focused fact per memory, but only ones that won't be captured automatically from the conversation.
- Use **only** `opsmemory-build` for build-time context. Never read or write `opsmemory-knowledge`, `opsmemory-investigator` or `opsmemory-e2e-*` for this purpose. Those are the application's runtime datapacks.
- Never put secrets, API keys, credentials or personal data into any datapack.
- Never copy Claude Code's MCP credentials into this repository, and never use them as the app's `MEKO_API_KEY`.

## Runtime datapack safety

- The demo datapacks (`opsmemory-knowledge`, `opsmemory-investigator`) must stay clean before a demo: promotions cannot be undone via the API.
- Test against `opsmemory-e2e-*`: run `npm run e2e`, `npm run dev:rehearse`, or set `MEKO_DATAPACK_PREFIX=opsmemory-e2e`.
- Don't run `npm run ops approve` or `npm run check:scopes` against the demo datapacks.
- `npm run test:approval` is offline and safe to run any time.
