# Local awareness MVP: scope and tester guide

Goal: residents can find something relevant, understand its source, and follow
what happens next. Personas below are recruitment hypotheses, not demographic
data to collect or automatic ranking rules.

## Working in this MR

| Workflow                    | Entry and behavior                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Browse first                | Activity, Nearby, and Timelines work without an account. For me links to interest setup.                                          |
| Preview an interest         | /interests offers named topics, a board selector, and an official-record search. Preview up to 12 results before following.       |
| Save a profile of interests | Signed-in readers follow topics, boards, searches, and specific matters. Each follow has a town. Add interests in multiple towns. |
| Follow a place              | Nearby leads to a property timeline with a watch control. Street/facility searches follow words, not geographic distance.         |
| Return to followed activity | /for-me shows up to 40 records ordered by event date, with explicit match reasons. A record can match several follows.            |
| Adjust relevance            | Unfollow from the preview or remove a follow from /my.                                                                            |
| Choose an entry point       | For me saves Activity, Nearby, Timelines, or For me as this browser's starting view. The brand link and /start use it.            |

Topics map to existing channels. This is deliberately a first classification,
not a claim to cover childcare availability, every school service, or all parks.
Townwide and unmapped records can appear through topic, board, and search follows.
No mail or push notifications are sent. The personal Atom feed remains available.

Subscriptions use the existing account store for SQLite and Supabase; no new
schema or live database migration is required. The starting view is a browser
cookie and does not synchronize across devices.

## Later increments

- Saved geographic areas: labeled map center/radius, multiple areas, and map selection.
- Geographic relevance: affected site versus meeting venue; townwide, unknown, and multiple-site scope.
- Street tiles and synchronized map/list selection with usable mobile interactions.
- Catch-up: distinguish discovery, publication, revision, and event dates before adding a last-seen cursor.
- Separate upcoming events from recently changed records in For me.
- Richer topic associations with evidence and optional manual interpretation.
- Cross-device starting preferences and optional notification delivery.

Do not call the current For me page “new since last visit.” It uses event dates.
Do not describe an address search as a radius or treat an empty map as complete coverage.

## Initial tester session (20–30 minutes)

Recruit 6–8 people representing overlapping profiles below. Use actual collected
records or clearly labeled synthetic fixtures. Do not create fake public accounts.
Avoid real home addresses when a public place serves the same testing purpose.

Prepare a known mapped matter, a townwide record, an unplaced address, and two
towns with different board activity. Keep the same dataset during comparisons.

1. Without signing in: “Find something locally you would want to know about.”
2. “Find out what has happened with it, and show where that information came from.”
3. “Show how you would keep track of it.” Sign in when prompted and verify the follow.
4. “Add an interest in another town.” Check that For me explains both town scopes.
5. “Find something relevant that might not have a map pin.”
6. “Remove something that is making this too broad.”
7. “Make the map your usual starting point.” Reopen the brand link.

For future catch-up concepts, use two prepared snapshots with known additions
and revisions. Ask what changed; do not present that behavior as implemented yet.

Capture task completion, wrong turns, misunderstood labels, source discovery,
match-reason comprehension, and one thing the tester would voluntarily return for.
Ask “What did you expect to happen?” before explaining a confusing control.
Classify each issue as navigation, terminology, matching, missing source coverage,
or missing feature. An empty useful topic can be a data problem.

## Persona coverage: 24 hypotheses

| Profile                            | Starting interest               | Test emphasis                   |
| ---------------------------------- | ------------------------------- | ------------------------------- |
| New resident without kids          | Town institutions               | Browse and choose a board       |
| Longtime resident without kids     | Neighborhood change             | Find an unfamiliar matter       |
| Parent with an infant              | Childcare and parks             | Identify coverage gaps          |
| Preschool parent                   | Playgrounds and early education | Search a facility               |
| Elementary parent                  | School and safe routes          | Combine topic and place         |
| Middle-school parent               | Education and recreation        | Find relevant records           |
| High-school parent                 | Facilities and school spending  | Inspect a timeline              |
| Parent across school stages        | Multiple schools                | Follow more than one interest   |
| Disability caregiver               | Access and support decisions    | Verify source evidence          |
| Shared-custody parent              | Two communities                 | Cross-town follows              |
| Grandparent providing childcare    | Schools, parks, library         | Facility search                 |
| Empty nester                       | Spending and development        | Browse broadly                  |
| Retiree living alone               | Services and access             | Understand topic labels         |
| Adult caring for an older relative | Another neighborhood            | Follow a second place           |
| Renter                             | Housing and services            | Find local relevance            |
| Condo owner                        | Property and surroundings       | Follow a property matter        |
| Neighbor of a proposed project     | Hearing progression             | Inspect and follow a timeline   |
| Homeowner planning work            | Similar proceedings             | Search and compare sources      |
| Commuter                           | Roads and parking               | Corridor search limitations     |
| Walker or cyclist                  | Crossings and sidewalks         | Geographic coverage gaps        |
| Local business owner               | Bylaws and construction         | Board and search follows        |
| Environmental volunteer            | Wetlands and development        | Follow sites and proceedings    |
| Budget-focused resident            | Articles and procurements       | Follow non-geographic matters   |
| New civic participant              | Upcoming local decisions        | Find meeting/source information |

Success criterion for this round: testers can find relevant material, explain why
it appeared, reach the source, and save/remove a follow without facilitator help.
Record counts and completion times as observations; do not invent validated targets.
