# GCS browser-direct upload requires CORS config on the bucket

Server-side signed URL flow + browser PUT crosses origins. The
bucket needs a cors block authorizing the web service origin(s)
for PUT + OPTIONS, otherwise the browser blocks with
"Failed to fetch" before the PUT body is even sent.

Mock-based unit tests don't catch this — fetch mocks return
synthetic 200s without exercising real preflight. Verify with:
  - Real browser preflight via Chrome MCP javascript_tool
  - Manual DevTools Network inspection on a real upload

Reference: KAN-855 shipped GCS bucket + signed URL flow without
CORS. KAN-875 caught the gap at Cohort 6 visual QA when Fred
tried to upload a logo. Fix-forward landed in 5ef5f87
(Terraform: cors block on growth-tenant-assets allowing PUT +
OPTIONS from growth-web run.app origins).

Sibling discipline to feedback_smoke_must_exercise_data_path.md
(KAN-873). Both share a root cause: mock-based tests skip the
real network boundary.
