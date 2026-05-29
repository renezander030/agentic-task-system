export { validateAdapter, adapterCapabilities } from './adapter-interface.js';
export { rrf, fuse, find, loadCorpus, similar, RRF_K } from './retrieval.js';
export {
  read as readCorpus,
  write as writeCorpus,
  meta as corpusMeta,
  clear as clearCorpus,
} from './corpus-cache.js';
export { record as logUsage } from './usage-log.js';
export { runConformance, formatConformance } from './conformance.js';
