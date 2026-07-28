## What this changes

<!-- One or two sentences. What behaviour is different after this than before? -->

## Why

<!-- The problem being solved. Link an issue if there is one. -->

## How

<!-- The approach, and anything a reviewer would otherwise have to reconstruct from the diff. -->

## Effect on analysis output

<!-- If this changes what the engines produce, paste a before-and-after from
     `pnpm analyze <some-repo>`. This is the fastest way for a reviewer to see the effect.
     Delete this section if it does not apply. -->

## Checklist

- [ ] `pnpm verify` passes
- [ ] Tests cover the new behaviour; a bug fix has a test that fails without it
- [ ] Comments explain *why* where the reason is not obvious
- [ ] No new required environment variable — ForgeOS still runs with an empty environment
- [ ] Nothing claims more than the code can actually determine
- [ ] Commits follow Conventional Commits
