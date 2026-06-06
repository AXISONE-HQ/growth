# Discipline Memory Index

This file catalogs the `feedback_*.md` discipline memos in `docs/memories/`.
Each memo documents a pattern, an anti-pattern, and forward discipline.

**Index initialized 2026-06-06** via the memo banking sprint that landed
13 new memos from the Cluster IV-B (yesterday) + Dashboard v2 (today)
session work. Future PRs add their new memos to the appropriate section.

## Phase 1 / Design discipline

- [`feedback_phase_1_loc_estimates_undercount_state_handling`](memories/feedback_phase_1_loc_estimates_undercount_state_handling.md) — Multiply Phase 1 LoC estimates 2.5-3x for realistic delivery
- [`feedback_phase_1_must_verify_codebase_data_fetching_idiom`](memories/feedback_phase_1_must_verify_codebase_data_fetching_idiom.md) — Verify actual codebase hook libraries before naming (useEffect vs useQuery)
- [`feedback_phase_1_5_prod_sniff_can_reveal_empty_cognitive_infrastructure`](memories/feedback_phase_1_5_prod_sniff_can_reveal_empty_cognitive_infrastructure.md) — Empty PROD data → ship UI with empty-state branch; UI auto-evolves
- [`feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks`](memories/feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md) — Step 0 enumeration may reframe Phase 1 locks; hybrid fallback handles gracefully
- [`feedback_phase_1_must_enumerate_all_callers_of_modified_service_helpers`](memories/feedback_phase_1_must_enumerate_all_callers_of_modified_service_helpers.md) — Phase 1 must enumerate ALL callers of modified helpers; not just suspected ones
- [`feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model`](memories/feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md) — Pivot pattern when Phase 1 reveals a different lifecycle model than originally proposed
- [`feedback_prd_assumed_infrastructure_check_kan_786`](memories/feedback_prd_assumed_infrastructure_check_kan_786.md) — PRDs assume infrastructure that may not exist; verify before Phase 1 locks
- [`feedback_prd_path_systematic_error_apps_vs_packages`](memories/feedback_prd_path_systematic_error_apps_vs_packages.md) — Path errors in PRDs (apps/ vs packages/) compound across multiple Phase 1 traces

## Cascade / Typecheck discipline

- [`feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix`](memories/feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md) — Chronically-red workspaces hide cascade errors; fixing one error class unmasks others
- [`feedback_as_any_casts_mask_typecheck_signal_remove_during_wireup`](memories/feedback_as_any_casts_mask_typecheck_signal_remove_during_wireup.md) — `as any` casts mask real type errors; remove during panel wire-up
- [`feedback_as_any_cast_can_be_vestigial_test_remove_before_assuming_cascade`](memories/feedback_as_any_cast_can_be_vestigial_test_remove_before_assuming_cascade.md) — Test-remove `as any` before assuming cascade; cast often outlives its TS reason
- [`feedback_apps_api_compiled_js_artifacts_mask_source_ts_during_vitest`](memories/feedback_apps_api_compiled_js_artifacts_mask_source_ts_during_vitest.md) — apps/api compiled .js artifacts are load-bearing for vitest; regen after .ts edits
- [`feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant`](memories/feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant.md) — apps/api → packages/api imports require variable-specifier loader pattern (KAN-689 cohort)
- [`feedback_shared_helper_prisma_surface_expansion_ripples_caller_test_mocks`](memories/feedback_shared_helper_prisma_surface_expansion_ripples_caller_test_mocks.md) — Expanding a shared helper's prisma surface ripples to all caller test mocks

## Per-model / Schema discipline

- [`feedback_prisma_field_convention_per_model_must_verify_before_panel_wireup`](memories/feedback_prisma_field_convention_per_model_must_verify_before_panel_wireup.md) — Verify per-model Prisma camelCase + @map convention before wire-up
- [`feedback_kan_791_closedAt_dropped_use_stagehistory_for_closure_query`](memories/feedback_kan_791_closedAt_dropped_use_stagehistory_for_closure_query.md) — Use DealStageHistory for closure queries (closedAt dropped in KAN-791)
- [`feedback_kan_791_dropped_model_residual_references`](memories/feedback_kan_791_dropped_model_residual_references.md) — Residual references to dropped models surface across many files; audit comprehensively
- [`feedback_prisma_vector_index_silent_drop_drift`](memories/feedback_prisma_vector_index_silent_drop_drift.md) — Prisma vector indexes can silently drop on migration; audit + reapply

## Testing discipline

- [`feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres`](memories/feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md) — Raw SQL needs real-Postgres integration test; mocking $queryRaw masks SQL bugs
- [`feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock`](memories/feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md) — Backend behavior sentinels must exercise real backend code path (not mocked response)
- [`feedback_sentinel_regex_precision_scope_by_parens_not_substring`](memories/feedback_sentinel_regex_precision_scope_by_parens_not_substring.md) — Sentinel regex precision: scope by parens not free substring (avoid comment false positives)
- [`feedback_main_baseline_must_include_new_files_for_comm_23`](memories/feedback_main_baseline_must_include_new_files_for_comm_23.md) — comm -23 baseline must include new files; `git checkout main -- <path>` is no-op for untracked
- [`feedback_smoke_cleanup_pattern_depends_on_dispatch_path`](memories/feedback_smoke_cleanup_pattern_depends_on_dispatch_path.md) — Smoke cleanup variant (6/7/8/9-step) depends on engine chain's dispatch path
- [`feedback_smoke_tenant_config_gaps_block_headline_outcomes`](memories/feedback_smoke_tenant_config_gaps_block_headline_outcomes.md) — Tenant config gaps can block headline smoke outcomes; pre-flight config audit

## Patterns / Architecture

- [`feedback_decision_feed_union_pattern_composite_chronological_view`](memories/feedback_decision_feed_union_pattern_composite_chronological_view.md) — Server-side UNION pattern delivers composite UX without schema migration
- [`feedback_dashboard_internal_canonical_pattern_lock_useeffect_quartet`](memories/feedback_dashboard_internal_canonical_pattern_lock_useeffect_quartet.md) — Dashboard-internal canonical data-fetching pattern lock (useEffect quartet)
- [`feedback_brain_service_pure_module_pattern`](memories/feedback_brain_service_pure_module_pattern.md) — Brain Service pure-module pattern (no side effects in module load)
- [`feedback_brain_service_token_returns_not_cost_per_kan_745_alignment`](memories/feedback_brain_service_token_returns_not_cost_per_kan_745_alignment.md) — Brain Service returns tokens (not cost) per KAN-745 alignment; consumer computes cost
- [`feedback_stage_transition_engine_brain_consumer_pattern`](memories/feedback_stage_transition_engine_brain_consumer_pattern.md) — Stage transition engine = Brain consumer pattern (read-only Brain integration)
- [`feedback_pipeline_router_short_circuit_on_single_candidate`](memories/feedback_pipeline_router_short_circuit_on_single_candidate.md) — Pipeline router short-circuits on single-candidate routing (no scoring needed)
- [`feedback_send_policy_pure_code_no_llm_for_compliance_layer`](memories/feedback_send_policy_pure_code_no_llm_for_compliance_layer.md) — Send Policy must be pure code (no LLM) for compliance auditability
- [`feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence`](memories/feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence.md) — Legacy composer + Brain-driven shaper coexist; mode selection at dispatch time
- [`feedback_message_shaper_anti_repetition_engagement_history_pattern`](memories/feedback_message_shaper_anti_repetition_engagement_history_pattern.md) — Message Shaper anti-repetition via engagement history pattern
- [`feedback_outbound_engagement_co_located_with_action_outcome`](memories/feedback_outbound_engagement_co_located_with_action_outcome.md) — Outbound Engagement records co-located with ActionOutcome at dispatch time
- [`feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend`](memories/feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md) — Phase 2 wiring: Decision row shim for legacy publishActionSend path
- [`feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern`](memories/feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md) — Phase 2 wiring: email-only MVP skips other channels (whatsapp/sms/messenger)
- [`feedback_phase_2_wiring_post_commit_brain_eval_isolation`](memories/feedback_phase_2_wiring_post_commit_brain_eval_isolation.md) — Phase 2 wiring: post-commit Brain eval isolated from main transaction
- [`feedback_phase_2_wiring_repeatedly_surfaces_legacy_infrastructure_gaps`](memories/feedback_phase_2_wiring_repeatedly_surfaces_legacy_infrastructure_gaps.md) — Phase 2 wiring repeatedly surfaces legacy infrastructure gaps; audit before each wire-up
- [`feedback_reply_to_universal_at_publish_helper`](memories/feedback_reply_to_universal_at_publish_helper.md) — Universal reply-to helper at publish time (centralized routing)
- [`feedback_kan_796_threshold_gate_orthogonality_clarification`](memories/feedback_kan_796_threshold_gate_orthogonality_clarification.md) — KAN-796 threshold gate orthogonality clarification (independent gates)
- [`feedback_multi_turn_ai_conversation_proven_in_production`](memories/feedback_multi_turn_ai_conversation_proven_in_production.md) — Multi-turn AI conversation proven in production (Cluster I + KAN-1057 thread context)

## Git / Operational discipline

- [`feedback_git_checkout_b_does_not_verify_base_branch`](memories/feedback_git_checkout_b_does_not_verify_base_branch.md) — `git checkout -b` doesn't verify intended base; use explicit `origin/main` form
- [`feedback_migration_diff_script_pattern_for_destructive_changes`](memories/feedback_migration_diff_script_pattern_for_destructive_changes.md) — Migration diff script pattern for destructive changes (non-destructive preview first)
- [`feedback_env_var_default_fall_through_silent_typo`](memories/feedback_env_var_default_fall_through_silent_typo.md) — Env var default fall-through can silently mask typos
- [`feedback_gcs_browser_upload_requires_cors`](memories/feedback_gcs_browser_upload_requires_cors.md) — GCS browser uploads require CORS configuration on the bucket
- [`feedback_local_postgres_pgvector_parity_gap_kan_706`](memories/feedback_local_postgres_pgvector_parity_gap_kan_706.md) — Local Postgres pgvector parity gap (Cloud SQL vs local extension version mismatch)

## Historical / Per-ticket close memos

- [`feedback_kan_816_three_gap_discovery_via_preflight`](memories/feedback_kan_816_three_gap_discovery_via_preflight.md) — KAN-816 three-gap discovery via pre-flight audit (producer-consumer contract gaps)
- [`feedback_kan_839_inbound_content_visibility_close`](memories/feedback_kan_839_inbound_content_visibility_close.md) — KAN-839 close — conversation content visibility for Shaper (sibling to KAN-817 producer-consumer pattern)
- [`feedback_sprint_11_pre_silence_gap_closure`](memories/feedback_sprint_11_pre_silence_gap_closure.md) — Sprint 11-pre silence-gap closure (inbound visibility cluster close)

---

## Maintenance

When adding a new `feedback_*.md` memo:

1. Place the file in `docs/memories/` with YAML frontmatter (`name`, `description`, `type: feedback`)
2. Add a one-line entry to the appropriate category section above
3. If no category fits, add a new section heading
4. Update the "Index initialized" date if the index changes structure

The catalog is comprehensive (all 49 memos) as of 2026-06-06. Subsequent
PRs add their memos here so the catalog stays current.
