# SchoolDocs — PostgreSQL Edition (v4.0)

Online School Document Request and Physical Pickup Tracking System.

## What's new in v4.0
- Persistent PostgreSQL storage for student accounts, document requests, and request history.
- PostgreSQL-backed login sessions (`connect-pg-simple`) so sessions are not stored only in server memory.
- 12-digit LRN validation and unique database constraint.
- Password hashing with bcrypt.
- Parameterized SQL queries to protect against SQL injection.
- Database health check at `/api/health`.
- Optional one-time import from the previous `data/db.json` when the PostgreSQL database is empty.
- Registrar account is created from private environment variables, not demo credentials in source code.

## Requirements
- Node.js 18 or newer
- A PostgreSQL database

## Run locally
1. Copy `.env.example` to `.env` and fill in your local PostgreSQL connection string and secrets.
2. Create a PostgreSQL database (for example, `schooldocs`).
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

The app creates the required tables automatically on first startup. The SQL is also documented in `database/schema.sql`.

## Render deployment
1. Create a PostgreSQL database in Render (Dashboard → New → PostgreSQL).
2. Choose a plan with persistent database storage and note the **Internal Database URL** when your web service is in the same Render region. Keep the database and web service in the same region.
3. In Render, create/update the web service from this repository or Blueprint.
4. Set the following environment variables on the web service:
   - `DATABASE_URL`: the PostgreSQL Internal Database URL
   - `ADMIN_EMAIL`: the registrar email you control
   - `ADMIN_PASSWORD`: a unique password of at least 12 characters
   - `SESSION_SECRET`: generate a random secret of at least 32 characters (Blueprint can generate this automatically)
   - `NODE_ENV`: `production`
5. Deploy. Check `/api/health`; it should return `{ "ok": true, "app": "SchoolDocs", "database": "connected" }`.
6. Configure database backups / point-in-time recovery if supported by your selected database plan.

Do not paste database URLs, passwords, or secrets into GitHub, screenshots, or chat messages. Set them only in Render's Environment settings.

## Moving data from the JSON prototype
If the previous `data/db.json` file is present in the project at first startup and the PostgreSQL `users` table is empty, the app attempts a one-time import. It maps the older `studentNo` field to `lrn`. Back up the JSON file before attempting import. For an already deployed app, do not overwrite the database or redeploy an old JSON folder; use a deliberate migration procedure instead.

## Project code guide
- `server.js`: Express server, authentication, authorization, API endpoints, PostgreSQL queries, schema setup, and legacy import.
- `public/index.html`: browser interface for student registration/login, document requests, status tracking, and registrar controls. It communicates with the server using `/api/...` endpoints.
- `database/schema.sql`: readable reference copy of the PostgreSQL table definitions. The server runs equivalent table creation automatically.
- `package.json`: project metadata, run scripts, and Node dependencies.
- `package-lock.json`: exact dependency versions for repeatable installs.
- `render.yaml`: Render Blueprint service and environment-variable configuration.
- `.env.example`: names of local environment variables; contains placeholders only.
- `.gitignore`: prevents local secrets, dependencies, and local data from being uploaded.

## Data model
- `users`: student and registrar accounts; stores password hashes, role, and (for students) LRN / grade / section.
- `requests`: each document request and its current status.
- `request_history`: chronological status/note entries for each request.
- `user_sessions`: created and maintained by `connect-pg-simple` for persistent login sessions.

## API overview
- `POST /api/register` — create a student account.
- `POST /api/login` — authenticate a student or registrar.
- `POST /api/logout` — end the current session.
- `GET /api/me` — return the signed-in user's safe profile.
- `GET /api/requests` — students see their own requests; registrar sees all requests.
- `POST /api/requests` — student creates a document request.
- `PATCH /api/requests/:id` — registrar updates status and note.
- `GET /api/health` — app/database health check.

## Important security / production notes
This is an educational project foundation, not yet an approved production student-records system. Before real school use, arrange school authorization and a privacy review; verify student identities; enforce registrar account provisioning and password reset; add CSRF protection, login rate limiting, audit logging, backup/restore tests, monitoring, retention rules, and least-privilege database credentials. Use test data until the school approves the system. Never expose LRN or other student records publicly.
