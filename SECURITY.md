# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/adeelbandesha/mcp-server-boilerplate/security/advisories/new) (**Security → Report a vulnerability**).

Include the affected version or commit, the transport (`stdio` or `http`), steps to reproduce and the impact. You can expect an acknowledgement within 3 working days and a fix or mitigation plan within 14 days of confirmation. You will be credited in the advisory unless you ask not to be.

## Scope

In scope: the HTTP transport (bearer-token auth, Host allowlist, the loopback-only default), tool input validation, and anything that leaks `MCP_AUTH_TOKEN`, `NOTION_TOKEN` or other secrets into logs or tool output.

Out of scope: deployments that bind a non-loopback `HOST` behind no TLS, and vulnerabilities in the Docker daemon, Notion API or other services a tool calls.
