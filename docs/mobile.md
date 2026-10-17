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

## One backend: merge, deploy, then build

The website and installed app both use **https://towncivic.fly.dev**. There is
one Fly app, one ingestion pipeline, and the existing account service. No
preview backend or additional database is required. Following/unfollowing in a
beta changes the same reader account used on the website.

Committed public configuration:

| Setting            | Value                                  | Location                                                             |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------- |
| Expo owner/project | `deriteam/towncivic`                   | `apps/mobile/app.config.ts`                                          |
| EAS project ID     | `a261728d-fe6e-455d-8a63-879f98fa7e3b` | `apps/mobile/app.config.ts`                                          |
| iOS bundle ID      | `org.towncivic.reader`                 | `apps/mobile/app.config.ts`                                          |
| API origin         | `https://towncivic.fly.dev`            | `build.production.env.EXPO_PUBLIC_API_URL` in `apps/mobile/eas.json` |

The `testflight` profile inherits `production`: both use store distribution,
remote auto-incremented build numbers, the EAS production environment and the
same API URL. TestFlight is a distribution step, not another backend environment.
No additional EAS dashboard variables or GitHub repository variables are needed.
Older `MOBILE_API_URL`, `EAS_PROJECT_ID` and `TOWNCIVIC_BUNDLE_ID` GitHub variables
are no longer read by the workflow. If earlier setup added conflicting EAS
production variables or shell exports, remove those obsolete overrides.
Local development can still use `apps/mobile/.env` to point Metro at localhost
or a LAN address. Never put backend credentials in `EXPO_PUBLIC_*` variables.

### First rollout

1. Merge the mobile PR after CI passes. Signed compilation/device checks remain
   beta release gates; they do not require a separate backend before merging.
2. Run **Actions → Deploy → Run workflow → main**. Existing Fly, document-store
   and account configuration is reused. Merging alone does not trigger Deploy;
   the existing scheduled Refresh/Interpret deployment triggers remain in place.
   The deployment now checks `/api/v1/catalog` as well as the website and feeds.
3. Confirm the API is live:

```bash
curl -fsS https://towncivic.fly.dev/api/v1/catalog
```

Expect JSON with `"apiVersion":1`. Do not build against the old website version
without these endpoints. Backend code does not travel inside the iOS binary.

4. Update your local checkout to the merged main branch. Commit/preserve any
   local edits first; the project-ID fix is now included in the repository.
   From the repository root:

```bash
git switch main
git pull --ff-only
npm ci
cd apps/mobile
npx eas-cli@24.10.0 login
npx eas-cli@24.10.0 build --platform ios --profile testflight
```

Apple signing credentials for this project have been configured by the owner.
EAS can reuse them. Run the first build interactively so any remaining Apple or
remote build-number initialization can prompt. No manual project linking or
API-URL exports are needed. Follow the EAS URL until the signed build succeeds;
a JavaScript export alone does not prove native compilation/signing succeeds.

### Subsequent builds from GitHub

Set **one repository secret**, `EXPO_TOKEN`, to an Expo access token belonging
to an account with access to `deriteam/towncivic`. Keep the token out of git.

Run **Actions → Mobile TestFlight → Run workflow**, using workflow branch `main`
and `source_ref=main` (the default). The workflow runs typecheck/lint/API-client
tests, checks the live catalog at the API origin read from `eas.json`, and queues
a signed build. It records the exact source SHA. It does not deploy the backend,
submit to Apple, or build automatically after every ingestion refresh.

A green GitHub run means EAS accepted the build request. Follow the EAS build URL
and confirm the native build succeeds before submitting. Trusted feature branches
or commit SHAs can still be selected with `source_ref`; their API requirements
must already be available on the shared backend. Only dispatch trusted repository
code because the EAS build step receives `EXPO_TOKEN`.

### Submit and invite testers

From `apps/mobile`, submit the **exact successful EAS build ID**:

```bash
npx eas-cli@24.10.0 submit --platform ios --profile testflight --id YOUR-BUILD-ID
```

The first submission prompts for the App Store Connect app and submission
credentials, which are separate from build signing. Select/create the app with
bundle ID `org.towncivic.reader`. Once known, its non-secret numeric Apple ID can
be saved as `submit.testflight.ios.ascAppId` in `eas.json`. Apple private keys and
passwords belong in EAS credential management, not the repository.

In App Store Connect, finish beta metadata/export-compliance questions, add the
build to a TestFlight group and invite your partner. External testers need beta
review. Builds expire after 90 days. TestFlight launches the bundled app without
Metro or your laptop; the same live backend used by the website stays available.
Submission to TestFlight does not release the app publicly in the App Store.

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
