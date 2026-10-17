# TownCivic mobile reader

The first native client is Expo SDK 57 / React Native 0.86, in the existing
repository. It targets iPhone and iPad; Android can be built from the same source
but is not a validated release target yet. SDK 57 requires iOS 16.4 or newer.

## Repository layout

| Location                         | Responsibility                                                        |
| -------------------------------- | --------------------------------------------------------------------- |
| `apps/mobile/`                   | Expo screens, device storage, navigation, app config and EAS profiles |
| `packages/api-contracts/`        | Versioned JSON response types, with no server or UI dependencies      |
| `src/api/`                       | HTTP JSON adapters for the shared backend                             |
| `src/read-models/`               | Queries shared between mobile JSON and HTML rendering                 |
| `src/web/`                       | Existing Hono server and website                                      |
| `src/pipeline/`, `src/commands/` | Existing ingestion and operations                                     |
| `.github/workflows/`             | Repository-wide CI, data jobs, deployment and mobile build dispatch   |

One npm workspace and root lockfile are enough; no Nx/Turbo service is needed.
We leave the existing server/CLI in place to avoid moving deployment paths in
the first mobile PR. A later `apps/server` extraction can be mechanical.
`ios/` and `android/` are generated _inside_ `apps/mobile` by Expo prebuild/EAS
and ignored. Configure native behavior through `app.config.ts` and plugins.

Node >=22.13 is required for the whole workspace. Install with `npm ci` at the
root. Backend-only operational jobs use `npm ci --workspaces=false`; the Docker
image excludes native dependencies and mobile source.

## What this beta does

- Transcript-first meetings, board/time filters, full-text search and pagination.
- General activity feed and issue timelines using the same records as the site.
- Virtualized transcript reading, literal find-in-transcript, timestamps opening
  the publisher's video, source/document links and native sharing.
- iPad meeting list/detail at widths >=850 points; stacked navigation on iPhone
  and narrow iPad windows. Portrait and landscape are supported.
- Existing-account email/password sign-in, secure native session persistence,
  token rotation and following/unfollowing issue timelines across web/mobile.

No new account database or direct database credentials are installed on the
device. The API reuses the existing `AccountStore`; hosted account operations
still run as the authenticated reader. Public browsing never requires login.
The beta does not yet include native signup/recovery, street preferences, map,
notifications, saved offline records, or native purchases. Existing account
creation/recovery stays on the website. Automatic captions and inferred timeline
stages retain their provenance notices. Seeded content is visibly labelled.

## Local development

From the repository root:

```bash
npm ci
npm run seed
npm run link
npm run serve -- --port 8787
```

In another terminal:

```bash
cp apps/mobile/.env.example apps/mobile/.env
# Edit EXPO_PUBLIC_API_URL in that file:
# iOS Simulator: http://localhost:8787
# physical device on the same LAN: http://YOUR-MAC-LAN-IP:8787
npm run mobile
```

Use `npm run mobile -- --go` to try Expo Go while iterating supported modules.
Use a development build for the actual app runtime. Metro serves the JavaScript;
the physical device must also be able to reach the backend. An Expo tunnel only
tunnels Metro, not the backend. HTTP endpoints are for development; TestFlight
requires HTTPS. Restart Metro after changing `.env`.

To create a local development build on a Mac with Xcode installed:

```bash
cd apps/mobile
npx expo run:ios --device
```

The EAS `development` profile produces an ad-hoc development-client build;
`simulator` produces a simulator-only build. Neither is a TestFlight binary.
The optional browser preview (`npm run web --workspace @towncivic/mobile`) is
useful for layout review; its sessions are memory-only. It does not replace
physical iOS validation or the existing server-rendered website.

## Build from the feature branch and send to TestFlight

**Yes: a feature-branch checkout can produce a TestFlight build.** Apple receives
a signed binary and build number, not a Git branch. EAS uploads the checked-out
source. Record the commit SHA with each beta and use a clean checkout for releases.
Backend code does not travel inside the iOS binary: deploy this branch's `/api/v1`
endpoints to an HTTPS preview backend first, or deploy the backward-compatible
API separately before pointing the app at production. The existing website
alone, without the new API, cannot serve this client.

1. Renew/enroll the Apple developer account. Choose a permanent bundle ID
   (proposed default: `org.towncivic.reader`) and create its App Store Connect app.
   Keep that ID consistent across the Expo config, provisioning and Apple record.
2. Create/link an Expo project. From `apps/mobile`, run
   `npx eas-cli@24.10.0 login`, then `npx eas-cli@24.10.0 init`.
   Because the config is dynamic, EAS may ask you to add `extra.eas.projectId`
   manually. Set `EAS_PROJECT_ID` to the UUID it reports (the config reads it),
   or commit the non-secret ID directly in `app.config.ts`. Confirm with
   `npx eas-cli@24.10.0 project:info`.
3. In the EAS **preview** environment, configure plain-text variables
   `EXPO_PUBLIC_API_URL`, `EAS_PROJECT_ID`, and `TOWNCIVIC_BUNDLE_ID`.
   Use the same values in your shell for local config evaluation. The API URL
   is bundled public configuration; never put secrets in `EXPO_PUBLIC_*`.
   The `testflight` profile explicitly uses EAS preview; `production` uses
   a separate production environment.
4. From a clean feature-branch checkout, run:

```bash
git switch feat/mobile-reader
npm ci
npm run typecheck
npm test
npm run mobile:typecheck
npm run mobile:lint
cd apps/mobile
export EAS_PROJECT_ID='YOUR-EXPO-PROJECT-UUID'
export TOWNCIVIC_BUNDLE_ID='org.towncivic.reader'
export EXPO_PUBLIC_API_URL='https://YOUR-PREVIEW-BACKEND'
npx eas-cli@24.10.0 build --platform ios --profile testflight
```

The first interactive build configures Apple certificates/provisioning with
EAS. `autoIncrement` and remote version tracking provide successive iOS build
numbers. A successful EAS build is an installable native binary; the Linux CI
bundle check alone is not.

5. Submit the **exact successful EAS build ID** (shown in its build details):

```bash
npx eas-cli@24.10.0 submit --platform ios --profile testflight --id YOUR-BUILD-ID
```

The first submission prompts for the App Store Connect app and credentials.
Once known, put its non-secret numeric `ascAppId` in
`submit.testflight.ios.ascAppId` in `eas.json`. Keep Apple private keys and
passwords in EAS credential management, not the repository. Submission uploads
to App Store Connect/TestFlight; it does not release the app publicly.

6. In App Store Connect, finish beta metadata/export-compliance questions, add
   a TestFlight group and invite your partner. External testers need the initial
   beta review. Builds expire after 90 days. TestFlight installs and launches the
   bundled app without Metro or your laptop running; its HTTPS backend must stay up.

The new `Mobile TestFlight` Action queues a build only when manually dispatched;
it never runs on PRs and does not submit to Apple. Configure repository secret
`EXPO_TOKEN` and variables `EAS_PROJECT_ID`, `TOWNCIVIC_BUNDLE_ID`, `MOBILE_API_URL`
after completing an interactive build. Keep them consistent with EAS preview.
The run records its commit and checks the backend catalog before queuing.

**GitHub bootstrap caveat:** a new `workflow_dispatch` workflow must exist on
the default branch before GitHub exposes it for manual dispatch. Until that
small workflow is merged, the EAS CLI commands above work directly from this
feature branch. Afterwards use the workflow from `main` and set its `source_ref`
input to `feat/mobile-reader` (or a reviewed commit SHA), or run
`gh workflow run mobile-testflight.yml --ref main -f source_ref=feat/mobile-reader`.
Only select trusted repository code: the EAS build step receives `EXPO_TOKEN`.
The workflow records the checked-out source SHA, which can differ from the
workflow's own commit on main. It fails early if the source has no mobile app.

## API and compatibility

| Endpoint under `/api/v1`                      | Purpose                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /catalog`                                | API version, served towns and default town                                  |
| `GET /events`                                 | `town`, `q`, `view=transcripts\|meetings\|activity`, `body`, `when`, `page` |
| `GET /events/:id`                             | Record, transcript segments, source links and related matters               |
| `GET /matters`                                | Label search, `town`, `q`, `page`; excludes single-record matters           |
| `GET /matters/:id`                            | Timeline with source evidence and ordered records                           |
| `POST /session`                               | JSON email/password to opaque session token                                 |
| `GET /session`, `DELETE /session`             | Resolve/revoke the bearer session                                           |
| `GET /following`                              | Reader's followed timelines                                                 |
| `PUT /following/:id`, `DELETE /following/:id` | Follow/unfollow a timeline                                                  |

Pages contain 30 items, totals and `nextPage`. Bad filters are 400; missing or
unserved records are 404. Responses are explicit DTOs rather than database rows.
Record text is plain text, not HTML. Source links only open HTTP(S) URLs.

Authenticated routes accept only `Authorization: Bearer ...`, never browser
cookies, and responses are `private, no-store`. A rotated session is returned
as `x-towncivic-session`. The native client serializes authenticated requests and
persists rotations before sending the next request. Tokens are keyed by backend
origin in Expo SecureStore; browser preview uses memory. HTTP is rejected by
release clients. Account access remains subject to the existing store's session
validation and hosted RLS. No auth schema, policies or privileged grants change.

Web and mobile share the meeting read model and underlying repository queries.
Keep `/api/v1` backward-compatible because installed beta/app versions may lag
the backend. Use additive fields or a new API version for breaking changes.
General activity uses simple date ordering in mobile; the website separately
groups upcoming and past records.

## Validation and release gates

Automated: root typecheck/tests/format, mobile typecheck/lint and iOS Hermes
export. API tests cover search, filtering, pagination, missing records, timeline
links, cookie rejection, account isolation, session rotation and sign-out using
both account-store implementations (hosted service simulated, not live).
Transport tests cover rotation races, endpoint validation and network failures.

Before inviting a tester, record a signed EAS build and validate on real devices:

- iPhone: search a known Milton phrase, read a transcript, open a timestamp,
  return, share the source, paginate and switch towns.
- iPad: portrait/landscape and narrow multitasking window; list/detail selection,
  keyboard, text size and scrolling long transcripts.
- Sign in with a confirmed existing account, follow a timeline, verify it on the
  website, force-close/reopen, verify persistence, then sign out and reopen.
- Background long enough to exercise token refresh; test expired/revoked login.
- Airplane mode, retry, empty results and an API-unavailable response.

Before public App Store release: finish app artwork (starter icon is temporary),
privacy policy/disclosures, support contact, accessibility review and any account
deletion/signup requirements associated with the final account flow. Native
compilation, signing, TestFlight processing and physical-device behavior cannot
be proven by a JavaScript export. OTA updates are not configured in this first
branch; ship beta changes as explicit builds.

References: [Expo monorepos](https://docs.expo.dev/guides/monorepos/),
[EAS monorepos](https://docs.expo.dev/build-reference/build-with-monorepos/),
[EAS iOS submission](https://docs.expo.dev/submit/ios/),
[TestFlight](https://developer.apple.com/testflight/).
