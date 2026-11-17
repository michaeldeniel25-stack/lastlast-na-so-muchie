# SchoolDocs v4.0 — Code Guide (Simple Explanation)

## 1. How the whole website works

A student opens `public/index.html` in a browser. The page sends requests to the Express server in `server.js` using the `/api` routes. The server checks the user's session and permissions, then reads or writes information in PostgreSQL. PostgreSQL keeps the records independently of the web server, so a normal app restart or redeploy does not erase the database.

```text
Student / Registrar browser
          |
          | HTML, CSS, JavaScript
          v
 public/index.html
          |
          | fetch('/api/...')
          v
      server.js (Express)
       |      |       |
       |      |       +-- bcryptjs: password hashing/checking
       |      +---------- express-session: login sessions
       |                    connect-pg-simple: saves sessions in PostgreSQL
       v
    pg (Node PostgreSQL client)
          |
          v
     PostgreSQL database
       |       |          |
      users  requests  request_history
```

## 2. Main files

- `public/index.html`: the visible user interface. It contains the page layout, styles, student forms, dashboard, request list, and browser JavaScript.
- `server.js`: the backend. It receives API requests, validates information, checks login and roles, and runs SQL queries.
- `package.json`: lists the libraries the project needs and the `npm start` command.
- `package-lock.json`: records the dependency tree used by npm. Run `npm install` after changing dependencies so npm can update this file.
- `render.yaml`: tells Render how to build and start the web service and which environment variables must be supplied.
- `.env.example`: example names for local secrets. Copy it to `.env` for local use; never upload the real `.env` file.
- `database/schema.sql`: readable reference for the database tables. The server also creates these tables automatically when it starts.
- `.gitignore`: prevents local secrets, node_modules, and local JSON data from being committed.

## 3. What each database table stores

### users
One row per student or registrar. It stores the person's name, email, role, hashed password, and student details. The LRN is unique and must be 12 digits for newly registered students. Passwords are never stored as plain text.

### requests
One row for each document request. It stores the student, document type, purpose, number of copies, current status, registrar note, and dates.

### request_history
A timeline of changes to a request. For example: Pending → Processing → Ready for Pickup → Completed. This keeps earlier status events instead of only showing the latest status.

### user_sessions
Created by the session-store library. It stores login sessions in PostgreSQL so sessions are not held only in the web server's memory.

## 4. Important parts of server.js

- Environment setup: reads private settings such as `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
- PostgreSQL Pool: maintains reusable database connections.
- `initializeDatabase()`: creates the tables and indexes if they do not exist.
- `ensureRegistrar()`: creates the first registrar account from private environment variables if no registrar account exists yet.
- `importLegacyJsonIfEmpty()`: optionally imports the old `data/db.json` once, only when the PostgreSQL users table is empty. Back up the old JSON file first.
- `requireAuth()`: checks that a user has a valid login session.
- `requireRegistrar()`: prevents student accounts from using registrar-only actions.
- `POST /api/register`: validates student details and saves a new student.
- `POST /api/login`: checks the email and password, then starts a new session.
- `POST /api/logout`: destroys the session.
- `GET /api/me`: returns the signed-in user's safe profile (never the password hash).
- `GET /api/requests`: returns a student's own requests or all requests for the registrar.
- `POST /api/requests`: saves a new student request and its first history event in one database transaction.
- `PATCH /api/requests/:id`: registrar changes a status or note and adds a history event.
- `GET /api/health`: checks that the app can query PostgreSQL.

## 5. What is a database transaction?

A transaction groups related database changes so they succeed together. When a student submits a request, the server saves the request and its first history event in one transaction. If one step fails, the server rolls back the transaction rather than leaving half a record.

## 6. What is parameterized SQL?

A query such as `SELECT * FROM users WHERE email = $1` sends the email separately from the SQL command. This helps prevent SQL injection. Avoid building SQL by joining user input directly into a query string.

## 7. How to deploy this edition

1. Replace the old project files in your GitHub repository with this v4.0 package.
2. Commit and push the changes to the `main` branch.
3. In Render, create a PostgreSQL database. Select a plan that meets your persistence needs; check its current price and free-plan limitations before confirming.
4. Choose the same Render region for the database and web service.
5. Copy the database's **Internal Database URL** from its Connect page.
6. In the web service's Environment settings, set `DATABASE_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. Keep the generated `SESSION_SECRET`. Do not share these values.
7. Deploy the web service and visit `/api/health`. It should report that the database is connected.
8. Test with fake student information and a test 12-digit LRN.

## 8. Important cautions

- A PostgreSQL database is persistent storage, but persistence is not the same as backup. Configure backups and test restoration.
- Keep the database and web service in the same Render region and use the Internal Database URL from the web service.
- Do not use real student records until the school authorizes the project and its privacy/security controls have been reviewed.
- This is still a school-project prototype. Add CSRF protection, login rate limiting, password reset, registrar provisioning controls, audit logs, privacy notice, monitoring, and backup/restore procedures before real deployment.
