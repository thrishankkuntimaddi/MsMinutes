# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, use GitHub's [private vulnerability reporting](https://github.com/thrishankkuntimaddi/MsMinutes/security/advisories/new), or email thrishankkuntimaddi@gmail.com.

Include what you found, how to reproduce it, and what an attacker could do with it. You should hear back within a week.

## Scope and deployment notes

Ms. Minutes is built to run on your own machine or home network:

- The brain listens on `127.0.0.1` by default. The WebSocket gateway and the `/api/*` endpoints have no authentication, so only set `HOST=0.0.0.0` on a network you trust (for example, so the desk companion can reach it).
- Keep your `.env` (API keys) out of version control; it is already in `.gitignore`.
- Her memories are stored locally under `data/` (or in the Postgres you point `MEMORY_DB` at) and can contain personal details from your conversations.
