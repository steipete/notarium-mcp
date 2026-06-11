# MCP Notarium

> [!WARNING]
> This repository is an unreleased 2025 prototype. It is not published on npm,
> is not release-ready, and should not be configured in an MCP client.

Use Automattic's maintained Simplenote integration instead:

- Repository: <https://github.com/Automattic/simplenote-mcp>
- npm: <https://www.npmjs.com/package/@automattic/simplenote-mcp>

```bash
npx -y @automattic/simplenote-mcp setup
```

Then register it with an MCP client:

```bash
codex mcp add simplenote -- npx -y @automattic/simplenote-mcp
```

The maintained implementation supports the current Simplenote authentication
flow, the macOS Simplenote data store, current MCP SDK behavior, and opt-in
write tools.

## Prototype Status

MCP Notarium was started in May 2025 as an experimental Simplenote-to-MCP
bridge. Version `1.0.0` was present in the initial package scaffold, not created
by a release process. The repository has no tags, GitHub Releases, changelog
history, or published `mcp-notarium` package.

The prototype is intentionally blocked from npm publication with
`"private": true` and a `prepublishOnly` guard. See
[RELEASE_READINESS.md](./RELEASE_READINESS.md) for the audit evidence.

## License

[MIT](./LICENSE)
