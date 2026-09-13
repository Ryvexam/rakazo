# Ryvoko UI + Effect

Use this skill for UI refactors in Ryvoko's web and Electron renderer.

## Non-negotiable UI rules

- Use the official shadcn/ui registry with Ryvoko's Base UI style. Never add a
  third-party component registry or copy an unreviewed component.
- Reuse primitives from `@ryvoko/ui-web` before writing local controls:
  `Button`, `Dialog`, `AlertDialog`, `Card`, `Field`, `Input`, `Textarea`,
  `Select`, `Popover`, `Command`, `Tabs`, `Switch`, `Checkbox`, `Badge`,
  `Skeleton`, `Spinner`, and `Tooltip`.
- Keep colors semantic and sourced from `@ryvoko/ui-tokens`. Do not add product
  hex values or arbitrary CSS variables. Bot identity colors and native window
  chrome are the only documented exceptions.
- Preserve routes, accessible names, keyboard behavior, `data-testid` values,
  `data-panel` attributes, and Playwright contracts.
- Prefer progressive disclosure and short copy. Do not add permanent help text
  or status chrome unless the user needs it to complete the current task.
- Keep mobile native-first; this skill governs the web/Electron renderer, not
  Expo navigation or native controls.

## Effect boundary

- Use `Effect` for a local async workflow with meaningful failure, cancellation,
  retry, or parallelism semantics. Do not replace every `Promise`, React hook,
  event handler, or oRPC contract with Effect.
- Keep React responsible for lifecycle and view state. Run Effects from an
  event handler or `useEffect`, and cancel/ignore stale work on cleanup.
- Translate provider/RPC errors into user-facing copy in the component, not in
  the Effect adapter. Preserve operation names and causes for diagnostics.
- Start with isolated settings or knowledge flows before touching the shell,
  composer, streaming events, OAuth polling, or computer updates.
- Add deterministic tests for success, failure, cancellation/stale responses,
  and pending-state cleanup for every migrated workflow.

## Verification

Run the smallest relevant checks first, then:

```bash
pnpm --filter @ryvoko/ui-web check
pnpm --filter @ryvoko/ui-web test
pnpm --filter @ryvoko/web check
pnpm --filter @ryvoko/web test
pnpm check
```

Do not include `infra/sandboxes/computer/vps-host` or any environment/production
file in UI commits.
