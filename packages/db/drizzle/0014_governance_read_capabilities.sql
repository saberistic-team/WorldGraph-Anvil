CREATE FUNCTION public.worldgraph_governance_actor_capability_v1(
  checked_world_id uuid,
  checked_actor_user_id uuid,
  checked_target_kind text,
  checked_target_id uuid,
  checked_snapshot_id uuid
)
RETURNS TABLE (
  actor_entity_id uuid,
  actor_entity_key text,
  membership_role text,
  eligible boolean,
  candidate_eligible boolean,
  has_ballot boolean,
  ballot_replacement_allowed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH visible_actor AS (
    SELECT membership.role::text AS membership_role
      FROM public.world_memberships membership
      JOIN public.worlds world ON world.id = membership.world_id
      JOIN public.world_governance_heads head ON head.world_id = world.id
     WHERE membership.world_id = checked_world_id
       AND membership.user_id = checked_actor_user_id
       AND membership.status = 'active'
       AND world.archived_at IS NULL
       AND world.lifecycle = 'active'
  ), controlled_entities AS (
    SELECT array_agg(controller.entity_id ORDER BY entity.logical_key::text COLLATE "C",
                     controller.entity_id) AS entity_ids,
           array_agg(entity.logical_key::text ORDER BY entity.logical_key::text COLLATE "C",
                     controller.entity_id) AS entity_keys
      FROM (
        SELECT scoped.entity_id
          FROM public.world_entity_controllers scoped
          JOIN public.world_entities scoped_entity
            ON scoped_entity.world_id = scoped.world_id
           AND scoped_entity.id = scoped.entity_id
         WHERE scoped.world_id = checked_world_id
           AND scoped.user_id = checked_actor_user_id
           AND scoped.control_scope = 'primary'
           AND scoped.revoked_at IS NULL
           AND scoped_entity.entity_type = 'player_character'
           AND scoped_entity.retired_world_version_id IS NULL
         ORDER BY scoped_entity.logical_key::text COLLATE "C", scoped.entity_id
         LIMIT 2
      ) controller
      JOIN public.world_entities entity
        ON entity.world_id = checked_world_id
       AND entity.id = controller.entity_id
  )
  SELECT CASE WHEN cardinality(controlled.entity_ids) = 1
              THEN controlled.entity_ids[1] ELSE NULL END,
         CASE WHEN cardinality(controlled.entity_keys) = 1
              THEN controlled.entity_keys[1] ELSE NULL END,
         visible.membership_role,
         CASE
           WHEN checked_snapshot_id IS NULL
             OR cardinality(controlled.entity_ids) <> 1 THEN false
           ELSE EXISTS (
             SELECT 1
               FROM public.eligibility_snapshots snapshot
               JOIN public.eligibility_snapshot_members member
                 ON member.world_id = snapshot.world_id
                AND member.snapshot_id = snapshot.id
                AND member.contest_id = snapshot.contest_id
              WHERE snapshot.world_id = checked_world_id
                AND snapshot.id = checked_snapshot_id
                AND member.voter_entity_id = controlled.entity_ids[1]
                AND (
                  (checked_target_kind = 'proposal' AND EXISTS (
                    SELECT 1
                      FROM public.proposal_contests mapping
                     WHERE mapping.world_id = snapshot.world_id
                       AND mapping.contest_id = snapshot.contest_id
                       AND mapping.proposal_id = checked_target_id
                  ))
                  OR (checked_target_kind = 'election' AND EXISTS (
                    SELECT 1
                      FROM public.election_contests mapping
                     WHERE mapping.world_id = snapshot.world_id
                       AND mapping.contest_id = snapshot.contest_id
                       AND mapping.election_id = checked_target_id
                  ))
                )
           )
         END AS eligible,
         CASE
           WHEN checked_target_kind <> 'election'
             OR cardinality(controlled.entity_ids) <> 1 THEN false
           ELSE COALESCE((
             SELECT public.worldgraph_governance_policy_matches_v1(
                      office.eligibility_policy,'in_world',
                      array[visible.membership_role],
                      coalesce(held_offices.office_keys,array[]::text[]),
                      coalesce(organizations.organization_keys,array[]::text[]),
                      'governance.nominate','office',office.stable_key::text,
                      clock.current_tick
                    )
               FROM public.elections election
               JOIN public.political_offices office
                 ON office.world_id=election.world_id and office.id=election.office_id
               JOIN public.world_simulation_clocks clock on clock.world_id=election.world_id
               LEFT JOIN LATERAL (
                 SELECT array_agg(source.office_key ORDER BY source.office_key COLLATE "C")
                          AS office_keys
                   FROM (
                     SELECT DISTINCT held.stable_key::text AS office_key
                       FROM public.office_seat_authority_intervals authority
                       JOIN public.political_offices held
                         ON held.world_id=authority.world_id
                        AND held.id=authority.office_id
                      WHERE authority.world_id=election.world_id
                        AND authority.holder_entity_id=controlled.entity_ids[1]
                        AND authority.effective_ticks @> clock.current_tick
                   ) source
               ) held_offices ON true
               LEFT JOIN LATERAL (
                 SELECT array_agg(source.organization_key
                                  ORDER BY source.organization_key COLLATE "C")
                          AS organization_keys
                   FROM (
                     SELECT DISTINCT organization.logical_key::text AS organization_key
                       FROM public.world_relationships relationship
                       JOIN public.world_entities organization
                         ON organization.world_id=relationship.world_id
                        AND organization.id=relationship.target_entity_id
                        AND organization.entity_type='organization'
                        AND organization.retired_world_version_id IS NULL
                      WHERE relationship.world_id=election.world_id
                        AND relationship.source_entity_id=controlled.entity_ids[1]
                        AND relationship.relationship_type='member_of'
                        AND relationship.retired_world_version_id IS NULL
                   ) source
               ) organizations ON true
              WHERE election.world_id=checked_world_id
                AND election.id=checked_target_id
              LIMIT 1
           ),false)
         END AS candidate_eligible,
         CASE WHEN cardinality(controlled.entity_ids) <> 1 THEN false ELSE EXISTS (
           SELECT 1
             FROM public.ballot_participation participation
            WHERE participation.world_id=checked_world_id
              AND participation.voter_entity_id=controlled.entity_ids[1]
              AND (
                (checked_target_kind='proposal' AND EXISTS (
                  SELECT 1 FROM public.proposal_contests mapping
                   WHERE mapping.world_id=participation.world_id
                     AND mapping.contest_id=participation.contest_id
                     AND mapping.proposal_id=checked_target_id
                ))
                OR (checked_target_kind='election' AND EXISTS (
                  SELECT 1 FROM public.election_contests mapping
                   WHERE mapping.world_id=participation.world_id
                     AND mapping.contest_id=participation.contest_id
                     AND mapping.election_id=checked_target_id
                ))
              )
         ) END AS has_ballot,
         CASE WHEN cardinality(controlled.entity_ids) <> 1 THEN false ELSE EXISTS (
           SELECT 1
             FROM public.ballot_participation participation
             JOIN public.governance_contests contest
               ON contest.world_id=participation.world_id
              AND contest.id=participation.contest_id
              AND contest.allow_replacement
            WHERE participation.world_id=checked_world_id
              AND participation.voter_entity_id=controlled.entity_ids[1]
              AND (
                (checked_target_kind='proposal' AND EXISTS (
                  SELECT 1 FROM public.proposal_contests mapping
                   WHERE mapping.world_id=participation.world_id
                     AND mapping.contest_id=participation.contest_id
                     AND mapping.proposal_id=checked_target_id
                ))
                OR (checked_target_kind='election' AND EXISTS (
                  SELECT 1 FROM public.election_contests mapping
                   WHERE mapping.world_id=participation.world_id
                     AND mapping.contest_id=participation.contest_id
                     AND mapping.election_id=checked_target_id
                ))
              )
         ) END AS ballot_replacement_allowed
    FROM visible_actor visible
    CROSS JOIN controlled_entities controlled
   WHERE checked_world_id IS NOT NULL
     AND checked_actor_user_id IS NOT NULL
     AND checked_target_kind IN ('world','proposal','election')
     AND checked_target_id IS NOT NULL
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_actor_capability_v1(
  uuid,uuid,text,uuid,uuid
) FROM PUBLIC,worldgraph_governance_tally;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.worldgraph_governance_actor_capability_v1(
  uuid,uuid,text,uuid,uuid
) TO worldgraph_app;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_proposal_result_v1(
  checked_world_id uuid,
  checked_actor_user_id uuid,
  checked_proposal_id uuid
)
RETURNS TABLE (
  result_id uuid,
  proposal_id uuid,
  outcome text,
  result_checksum bytea,
  input_checksum bytea,
  eligible_count integer,
  turnout_count integer,
  yes_count integer,
  no_count integer,
  abstain_count integer
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT result.id,result.proposal_id,result.outcome::text,result.result_checksum,
         tally.input_checksum,tally.eligible_count,tally.participating_count,
         coalesce(max(count.ballot_count)
           filter (where count.choice_code='yes'),0)::integer,
         coalesce(max(count.ballot_count)
           filter (where count.choice_code='no'),0)::integer,
         coalesce(max(count.ballot_count)
           filter (where count.choice_code='abstain'),0)::integer
    FROM public.world_memberships membership
    JOIN public.world_governance_heads head
      ON head.world_id=membership.world_id
    JOIN public.proposal_results result
      ON result.world_id=membership.world_id
     AND result.proposal_id=checked_proposal_id
    JOIN public.proposal_tallies tally
      ON tally.world_id=result.world_id AND tally.id=result.tally_id
    LEFT JOIN public.proposal_tally_counts count
      ON count.world_id=tally.world_id AND count.tally_id=tally.id
   WHERE membership.world_id=checked_world_id
     AND membership.user_id=checked_actor_user_id
     AND membership.status='active'
     AND NOT EXISTS (
       SELECT 1
         FROM public.proposal_results replacement
        WHERE replacement.world_id=result.world_id
          AND replacement.repair_of_result_id=result.id
     )
   GROUP BY result.id,tally.id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_proposal_result_v1(
  uuid,uuid,uuid
) FROM PUBLIC,worldgraph_governance_tally;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.worldgraph_governance_proposal_result_v1(
  uuid,uuid,uuid
) TO worldgraph_app;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_election_result_v1(
  checked_world_id uuid,
  checked_actor_user_id uuid,
  checked_election_id uuid
)
RETURNS TABLE (
  result_id uuid,
  election_id uuid,
  outcome text,
  result_checksum bytea,
  input_checksum bytea,
  eligible_count integer,
  turnout_count integer,
  winner_candidate_key text,
  abstain_count integer
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT result.id,result.election_id,result.outcome::text,result.result_checksum,
         tally.input_checksum,tally.eligible_count,tally.participating_count,
         winner.logical_key::text,
         coalesce(max(count.ballot_count)
           filter (where count.count_kind='abstain'),0)::integer
    FROM public.world_memberships membership
    JOIN public.world_governance_heads head
      ON head.world_id=membership.world_id
    JOIN public.election_results result
      ON result.world_id=membership.world_id
     AND result.election_id=checked_election_id
    JOIN public.election_tallies tally
      ON tally.world_id=result.world_id AND tally.id=result.tally_id
    LEFT JOIN public.candidacies winning
      ON winning.world_id=result.world_id
     AND winning.id=result.winning_candidacy_id
    LEFT JOIN public.world_entities winner
      ON winner.world_id=winning.world_id
     AND winner.id=winning.candidate_entity_id
    LEFT JOIN public.election_tally_counts count
      ON count.world_id=tally.world_id AND count.tally_id=tally.id
   WHERE membership.world_id=checked_world_id
     AND membership.user_id=checked_actor_user_id
     AND membership.status='active'
     AND NOT EXISTS (
       SELECT 1
         FROM public.election_results replacement
        WHERE replacement.world_id=result.world_id
          AND replacement.repair_of_result_id=result.id
     )
   GROUP BY result.id,tally.id,winner.logical_key
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_election_result_v1(
  uuid,uuid,uuid
) FROM PUBLIC,worldgraph_governance_tally;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.worldgraph_governance_election_result_v1(
  uuid,uuid,uuid
) TO worldgraph_app;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_election_result_counts_v1(
  checked_world_id uuid,
  checked_actor_user_id uuid,
  checked_result_id uuid
)
RETURNS TABLE (
  count_kind text,
  ballot_count integer,
  candidate_key text
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT count.count_kind::text,count.ballot_count,candidate.logical_key::text
    FROM public.world_memberships membership
    JOIN public.world_governance_heads head
      ON head.world_id=membership.world_id
    JOIN public.election_results result
      ON result.world_id=membership.world_id AND result.id=checked_result_id
    JOIN public.election_tally_counts count
      ON count.world_id=result.world_id AND count.tally_id=result.tally_id
    LEFT JOIN public.candidacies candidacy
      ON candidacy.world_id=count.world_id AND candidacy.id=count.candidacy_id
    LEFT JOIN public.world_entities candidate
      ON candidate.world_id=candidacy.world_id
     AND candidate.id=candidacy.candidate_entity_id
   WHERE membership.world_id=checked_world_id
     AND membership.user_id=checked_actor_user_id
     AND membership.status='active'
     AND NOT EXISTS (
       SELECT 1
         FROM public.election_results replacement
        WHERE replacement.world_id=result.world_id
          AND replacement.repair_of_result_id=result.id
     )
   ORDER BY candidate.logical_key::text COLLATE "C" NULLS LAST
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_election_result_counts_v1(
  uuid,uuid,uuid
) FROM PUBLIC,worldgraph_governance_tally;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.worldgraph_governance_election_result_counts_v1(
  uuid,uuid,uuid
) TO worldgraph_app;
