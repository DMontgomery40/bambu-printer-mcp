# Agent instructions for bambu-printer-mcp

Read [AGENTS.md](../AGENTS.md) at the repository root. It is the shared source of truth; do not duplicate or override its release ordering, validation requirements, printer safety, or Blender MCP rules here.

Real printer credentials belong in the ignored .env file. Use dummy values for tests, and set BAMBU_MODEL explicitly to an empty string when testing missing-model behavior so dotenv cannot supply the user's printer model.
