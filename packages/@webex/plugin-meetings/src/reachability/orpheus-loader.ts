import type {OrpheusFacade, OrpheusOptions} from './orpheus.types';

/** Loads the packaged browser runtime only when reachability is requested. */
export default class OrpheusLoader {
  /**
   * Resolve the browser entry emitted by the pinned Orpheus build.
   * @returns {Promise<Object>} Browser runtime exports.
   */
  static load(): Promise<{OrpheusReachability: new (options: OrpheusOptions) => OrpheusFacade}> {
    // This ESM runtime is staged into dist by build:orpheus, without Babel rewriting its worker URLs.
    // eslint-disable-next-line import/no-unresolved, import/extensions
    return import('./orpheus/js/orpheus-client.js');
  }
}
