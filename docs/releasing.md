# Releasing ATS

ATS is a JavaScript npm-workspaces monorepo. Publish its public npm packages,
the existing MCP server manifest, and one matching GitHub Release. The private
workspace is excluded. There is no Python distribution.

Before publishing, the release PR must be reviewed and accepted at its final
commit. Merge the reviewed commit, then use a clean checkout of that merged
revision. A changed PR needs another review. No registry publication belongs
in the PR CI job.

```sh
npm ci
npm test
npm run check:publish
npm run check:release
# Validate server.json against its declared JSON schema without publishing.
```

Some publisher versions advertise `validate` but do not implement it. In that
case use a JSON Schema validator against the schema declared in `server.json`;
do not use `publish` as a validation probe.

Check npm credentials with `npm whoami`. Publish core first, then the public
adapters, then CLI and MCP; consumers must not receive a package whose required
ATS dependency version is missing from npm. Use `npm publish --access public
--workspace PACKAGE_NAME` for each public workspace. Skip already-published
versions only after confirming the registry artifact matches the intended
release; npm package versions are immutable.

After all public packages are available, install the released CLI in a clean
directory and smoke-test `ats --version`, adapter configuration, `find`, and
`doctor`. Initialize the published MCP server over stdio and list its tools.
Check that `server.json` pins the published MCP package version and that the
package's `mcpName` matches the registry namespace.

Authenticate the MCP publisher with `mcp-publisher login github` if necessary,
then run `mcp-publisher publish server.json`. Verify the exact version in the
registry before creating the matching `vVERSION` GitHub Release from the merged
commit. Use the current changelog entry for its release notes. If publishing
stops partway, record the successful packages and resume from the remaining
ones; never mark the release complete while a required destination is missing.

Authentication details are documented by [npm](https://docs.npmjs.com/trusted-publishers/)
and the [MCP registry](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md).
