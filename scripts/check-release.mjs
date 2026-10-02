import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read('package.json');
const lock = read('package-lock.json');
const server = read('server.json');
assert.equal(lock.version, manifest.version, 'lockfile release version');
const packages = fs.readdirSync(path.join(root, 'packages')).map(name => ({ dir: `packages/${name}`, pkg: read(`packages/${name}/package.json`) }));
const names = new Set(packages.map(({ pkg }) => pkg.name));
for (const { dir, pkg } of packages) {
  assert.equal(pkg.version, manifest.version, `${pkg.name} release version`);
  assert.equal(lock.packages[dir].version, pkg.version, `${pkg.name} lockfile version`);
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] || {})) {
      if (names.has(name)) assert.equal(range, `^${manifest.version}`, `${pkg.name} dependency ${name}`);
    }
    assert.deepEqual(lock.packages[dir][section] || {}, pkg[section] || {}, `${pkg.name} ${section} lockfile`);
  }
}
const mcp = packages.find(({ pkg }) => pkg.name === '@reneza/ats-mcp').pkg;
assert.equal(server.version, manifest.version, 'MCP registry release version');
assert.equal(server.name, mcp.mcpName, 'MCP registry namespace');
assert.equal(server.packages[0].identifier, mcp.name, 'MCP registry npm package');
assert.equal(server.packages[0].version, mcp.version, 'MCP registry npm version');
console.log(`Release ${manifest.version} aligned across ${packages.filter(({ pkg }) => !pkg.private).length} public npm packages and MCP registry manifest.`);
