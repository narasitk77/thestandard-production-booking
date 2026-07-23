FROM node:20-alpine
# postgresql-client gives us psql/pg_isready for the defensive db-create step in start.sh
RUN apk add --no-cache openssl libc6-compat postgresql-client

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --legacy-peer-deps

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
