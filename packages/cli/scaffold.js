/**
 * `ats adapter new <name>` — generate a starter ATS adapter package.
 *
 * Writes a directory with a contract-complete skeleton (every required method
 * stubbed to throw "not implemented"), a package.json, and a README pointing at
 * `ats adapter test`. The whole loop is then: fill in six methods → run the
 * conformance kit → publish.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Slugify a raw name into the adapter's short id (the bit after ats-adapter-). */
export function adapterSlug(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/^ats-adapter-/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const indexTemplate = (slug) => `/**
 * @${'scope'}/ats-adapter-${slug} — an ATS storage adapter.
 *
 * Implement the six required methods (+ auth lifecycle) below and you're done:
 * core handles hybrid retrieval, RRF fusion, the corpus cache, and the CLI/MCP
 * surfaces for free. Verify your work any time with:
 *
 *     ats adapter test .
 *
 * Optional methods (searchByQuery, bulkFetch, embeddings) are picked up
 * automatically if present — they make retrieval better but are never required.
 */

const NOT_IMPLEMENTED = (m) => {
  throw new Error(\`ats-adapter-${slug}: \${m}() not implemented yet\`);
};

/** @type {import('@reneza/ats-core').Adapter} */
const adapter = {
  // ---- required: storage ---------------------------------------------------

  /** @returns {Promise<import('@reneza/ats-core').Project[]>} */
  async listProjects() {
    return NOT_IMPLEMENTED('listProjects');
  },

  /** @param {string} projectId */
  async listTasksInProject(projectId) {
    void projectId;
    return NOT_IMPLEMENTED('listTasksInProject');
  },

  /** @param {string} projectId @param {string} taskId */
  async getTask(projectId, taskId) {
    void projectId; void taskId;
    return NOT_IMPLEMENTED('getTask');
  },

  /** @param {import('@reneza/ats-core').TaskInput} input */
  async createTask(input) {
    void input;
    return NOT_IMPLEMENTED('createTask');
  },

  /** @param {string} projectId @param {string} taskId @param {import('@reneza/ats-core').TaskPatch} patch */
  async updateTask(projectId, taskId, patch) {
    void projectId; void taskId; void patch;
    return NOT_IMPLEMENTED('updateTask');
  },

  /** @param {{ projectId: string, taskId: string }} ref @returns {string} */
  urlFor(ref) {
    return \`https://example.com/\${ref.projectId}/\${ref.taskId}\`;
  },

  // ---- required: auth lifecycle -------------------------------------------
  // If your store needs no auth, return { authenticated: true } and a no-op login.

  async authStatus() {
    return { authenticated: true };
  },

  async authLogin() {
    return { instructions: 'No authentication required for this adapter.' };
  },

  // ---- optional (delete if unused) ----------------------------------------
  // async searchByQuery(query) { return []; },   // native full-text search
  // async bulkFetch() { return []; },             // single-call corpus refresh
  // async embeddings(texts) { return []; },       // dense vectors for hybrid retrieval
};

export default adapter;
`;

const pkgTemplate = (slug) =>
  JSON.stringify(
    {
      name: `ats-adapter-${slug}`,
      version: '0.1.0',
      description: `ATS storage adapter for ${slug}`,
      type: 'module',
      main: 'index.js',
      license: 'MIT',
      peerDependencies: { '@reneza/ats-core': '^0.4.0' },
      keywords: ['ats', 'ats-adapter', 'agent-memory', slug],
    },
    null,
    2
  ) + '\n';

const readmeTemplate = (slug) => `# ats-adapter-${slug}

A storage adapter for the [Agentic Task System](https://github.com/renezander030/agentic-task-system).

## Implement six methods

Open \`index.js\` and fill in the stubs. Then verify against the contract:

\`\`\`bash
ats adapter test .
\`\`\`

When every check passes, point ATS at it:

\`\`\`bash
ATS_ADAPTER=./path/to/ats-adapter-${slug} ats find "anything"
\`\`\`

See the [adapter contract](https://github.com/renezander030/agentic-task-system/blob/main/docs/adapter-interface.md).
`;

/**
 * Generate the scaffold on disk.
 *
 * @param {string} rawName
 * @param {{ dir?: string, force?: boolean }} [opts]
 * @returns {{ slug: string, dir: string, files: string[] }}
 */
export function scaffoldAdapter(rawName, opts = {}) {
  const slug = adapterSlug(rawName);
  if (!slug) throw new Error(`invalid adapter name: "${rawName}"`);
  const dir = path.resolve(opts.dir || `ats-adapter-${slug}`);
  if (fs.existsSync(dir) && !opts.force) {
    if (fs.readdirSync(dir).length > 0) {
      throw new Error(`${dir} already exists and is not empty (use --force to overwrite)`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['index.js', indexTemplate(slug)],
    ['package.json', pkgTemplate(slug)],
    ['README.md', readmeTemplate(slug)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { slug, dir, files: files.map(([n]) => n) };
}
