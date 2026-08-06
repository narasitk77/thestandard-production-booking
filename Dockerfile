FROM node:20-alpine
# postgresql-client gives us psql/pg_isready for the defensive db-create step in start.sh
RUN apk add --no-cache openssl libc6-compat postgresql-client

WORKDIR /app

# Install dependencies.
# v1.163.1 — the lockfile is COPIED and `npm ci` is used so the image is built
# from the EXACT dependency versions this repo was tested against. Before this,
# every image ran `npm install` against package.json alone, so each build silently
# picked up whatever had been published since the last one: a tsx 4.23.x release
# broke `--experimental-test-module-mocks` inside alpine and failed the build on
# a commit that touched none of it. Unpinned prod images were the real bug.
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Copy source
COPY . .

# Generate Prisma client + build Next.js
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Create uploads dir
RUN mkdir -p /app/uploads

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Stamp the build commit so the running app can report exactly what's deployed
# (see /api/version + the health page). Passed from CI; empty for local builds.
ARG APP_GIT_SHA=""
ENV APP_GIT_SHA=$APP_GIT_SHA

COPY start.sh ./start.sh
RUN chmod +x start.sh

CMD ["./start.sh"]
