# Independent project crews

One project = one group = four independent agent IDs. Names and responsibilities are
kept, but no messages, memory, workspace, assets, schedules or learned skills are copied.
The five configured skills and four role profiles are snapshotted once and copied into
each new crew. Local Codex authentication and media credentials stay service-side.

- Browser opens the selected project's crew chat. New project needs only a name.
- `新项目：需求` creates immediately; other substantive messages are classified by a
  fresh tool-free local Codex turn before any old chat context is loaded. The classifier
  sees only the current name/initial brief and latest message. Ambiguity stays current.
- A manually created blank crew consumes its first brief without creating another crew.
- New projects create no episodes or paid generations automatically. Production gates stay.
- Creation is one PostgreSQL transaction spanning public + studio schemas (same DB).
  Request IDs deduplicate retries. Studio pins bound agents to one project and filters
  project enumeration. Work orders never fall back to another project's member.
- Old project chats stay intact. Switching projects does not cancel existing production.

Deployment: rebuild app + studio, then run
`docker compose exec -T app node deploy/configure-project-crews.mjs` once to adopt
this site's existing `chuzhong` / `gmuj777qy` crew. This script is idempotent and fails
closed if the known setup no longer matches. Back up PostgreSQL before adoption.

Validation: `docker compose exec -T app node deploy/test-project-crews.mjs` uses an
always-rolled-back transaction; it neither leaves test projects nor calls any media API.
