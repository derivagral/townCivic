# townCivic's web tier.
#
# The database is baked in rather than fetched at boot, and that is the whole
# design decision this file encodes. It is legible because of what came before:
# readers live in Supabase, the document archive lives in a bucket, and what is
# left — `towncivic.db` — is read-only at serve time and about 24 MB. So the
# image can carry it, and carrying it is what makes starting unconditional.
#
# The alternative, downloading at boot, buys fresher data per restart and pays
# for it by putting a network call on the path to serving anything at all. A
# machine that restarts while the bucket is unreachable would not come up. Baked,
# the worst case is serving records a few hours old, which for a civic archive
# updated twice a day is not a meaningful degradation.
#
# It also makes the image the unit: a rollback returns matching code *and* data,
# and a bad database fails its health check during the rollout rather than after
# it. The trade is that new data needs a deploy — see `.github/workflows/deploy.yml`,
# which is one step after the refresh.
#
# Revisit when the database outgrows a few hundred megabytes. At that point the
# image gets slow to push and `snapshot --pull` at boot starts being the better
# deal — with a baked copy kept as the floor, so booting still cannot fail.

FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# `npm ci` without `--omit=dev` on purpose: this project runs TypeScript directly
# through `tsx`, which is a devDependency, so pruning it would leave an image
# that cannot start. There is no build step to prune *to* — the source is what
# runs, which is also what makes a stack trace in production point at a real
# line of this repository.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./

# The database. Put here by `snapshot --pull`, which is the step before this in
# `.github/workflows/deploy.yml`.
#
# Required rather than optional, and the build fails without it. That is the
# intended behaviour: an image that quietly shipped with no database would come
# up healthy, answer `/healthz`, pass its checks, and serve an empty archive to
# everybody. A build error naming a missing file is a far better outcome than a
# deployment that looks fine and holds nothing.
#
#   npm run snapshot -- --pull    # fetch the published database, then build
#
# `.dockerignore` keeps `data/documents/` — 553 MB of raw archive that nothing
# reads at serve time — out of the build context.
COPY data/towncivic.db ./data/towncivic.db

# Fly terminates TLS and forwards here.
ENV PORT=8080
EXPOSE 8080

# Not `npm start`: npm sits between the signal and the process, so a SIGTERM
# from Fly reaches the wrapper and the server never hears about the shutdown.
CMD ["npx", "tsx", "src/cli.ts", "serve"]
