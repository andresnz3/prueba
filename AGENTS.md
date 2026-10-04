# Project instructions

Read PHASE53.md for the current connected-mode scope; earlier phase reports are historical. Keep the local Dexie mode intact. Connected business authority comes exclusively from the authenticated backend session. Never write connected operations to Dexie or queue offline sales. Do not expose secrets, change existing accounts, commit, deploy, or migrate the principal database without explicit authorization.

## Skills

The project skill is `.agents/skills/emil-design-eng/SKILL.md`. Read and apply it for UI, interaction, animation, and accessibility work. Report which skills were used. UI review findings use a Before/After/Why markdown table. Select other session skills by task relevance; do not invoke unrelated workflows. This file preserves the user's preference to consult project instructions and use relevant skills on future tasks.

## Verification

Run full ESLint, backend unit tests, isolated MySQL integration tests, local and connected browser tests, public build verification, and git diff --check for substantial changes. MySQL tests use only validated random pos_auth_test_* databases, and must clean them up. Preserve existing tests except when their expected behavior is explicitly superseded by a requested feature; document that change. Serve only the public build. Keep database/schema.sql unchanged; schema changes are separate migrations.

Do not advance automatically to connected purchases. Await user review of phase 5.3 and validation of a real sale before starting that phase.
