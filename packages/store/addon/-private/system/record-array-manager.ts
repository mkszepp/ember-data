/**
  @module @ember-data/store
*/

import { A } from '@ember/array';
import { assert } from '@ember/debug';
import { set } from '@ember/object';
import { assign } from '@ember/polyfills';
import { _backburner as emberBackburner } from '@ember/runloop';

import { REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT } from '@ember-data/canary-features';

import isStableIdentifier from '../identifiers/is-stable-identifier';
import { AdapterPopulatedRecordArray, RecordArray } from './record-arrays';
import { internalModelFactoryFor } from './store/internal-model-factory';
import { RecordInstance } from '../ts-interfaces/record-instance';

type Meta = import('../ts-interfaces/ember-data-json-api').Meta;
type AdapterPopulatedRecordArrayCreator =
  import('./record-arrays/adapter-populated-record-array').AdapterPopulatedRecordArrayCreator;
type RecordArrayCreator = import('./record-arrays/record-array').RecordArrayCreator;
type InternalModelFactory<K> = import('./store/internal-model-factory').default<K>;
type CollectionResourceDocument = import('../ts-interfaces/ember-data-json-api').CollectionResourceDocument;
type Dict<T> = import('../ts-interfaces/utils').Dict<T>;
type CoreStore<T> = import('./core-store').default<T>;
type InternalModel<K> = import('ember-data/-private').InternalModel<K>;
type StableRecordIdentifier = import('../ts-interfaces/identifier').StableRecordIdentifier;

interface LegacyRecordArray {
  _removeInternalModels<K extends RecordInstance>(ims: InternalModel<K>[]): void;
  _pushInternalModels<K extends RecordInstance>(ims: InternalModel<K>[]): void;
}

const RecordArraysCache: WeakMap<StableRecordIdentifier, Set<RecordArray<object>>> = new WeakMap();

export function recordArraysForIdentifier(identifier: StableRecordIdentifier): Set<RecordArray<RecordInstance>> {
  let rdSet = RecordArraysCache.get(identifier);
  if (!rdSet) {
    rdSet = new Set();
    RecordArraysCache.set(identifier, rdSet);
  }

  return rdSet;
}

const pendingForIdentifier: Set<StableRecordIdentifier> = new Set([]);
const IMDematerializing: WeakMap<StableRecordIdentifier, InternalModel<any>> = new WeakMap();

function getIdentifier(identifierOrInternalModel: StableRecordIdentifier | InternalModel<any>): StableRecordIdentifier {
  let i = identifierOrInternalModel;
  if (!REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT && !isStableIdentifier(identifierOrInternalModel)) {
    // identifier may actually be an internalModel
    // but during materialization we will get an identifier that
    // has already been removed from the identifiers cache
    // so it will not behave as if stable. This is a bug we should fix.
    i = identifierOrInternalModel.identifier || i;
  }

  return i as StableRecordIdentifier;
}

// REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT only
function peekIMCache<K extends RecordInstance>(cache: InternalModelFactory<K>, identifier: StableRecordIdentifier): InternalModel<K> | null {
  if (!REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT) {
    let im: InternalModel<K> | null | undefined = IMDematerializing.get(identifier);
    if (im === undefined) {
      // if not im._isDematerializing
      im = cache.peek(identifier);
    }

    return im;
  }

  return cache.peek(identifier);
}

function shouldIncludeInRecordArrays<K extends RecordInstance>(store: CoreStore<K>, identifier: StableRecordIdentifier): boolean {
  const cache = internalModelFactoryFor(store);
  const internalModel = cache.peek(identifier);

  if (internalModel === null) {
    return false;
  }
  return !internalModel.isHiddenFromRecordArrays();
}

/**
  @class RecordArrayManager
  @internal
*/
class RecordArrayManager<K extends RecordInstance> {
  declare store: CoreStore<K>;
  declare isDestroying: boolean;
  declare isDestroyed: boolean;
  declare _liveRecordArrays: Dict<RecordArray<K>>;
  declare _pendingIdentifiers: Dict<StableRecordIdentifier[]>;
  declare _adapterPopulatedRecordArrays: RecordArray<K>[];

  constructor(options: { store: CoreStore<K> }) {
    this.store = options.store;
    this.isDestroying = false;
    this.isDestroyed = false;
    this._liveRecordArrays = Object.create(null) as Dict<RecordArray<K>>;
    this._pendingIdentifiers = Object.create(null) as Dict<StableRecordIdentifier[]>;
    this._adapterPopulatedRecordArrays = [];
  }

  /**
   * @method getRecordArraysForIdentifier
   * @internal
   * @param {StableIdentifier} param
   * @return {RecordArray} array
   */
  getRecordArraysForIdentifier(identifier: StableRecordIdentifier): Set<RecordArray<K>> {
    return recordArraysForIdentifier(identifier) as unknown as Set<RecordArray<K>>;
  }

  _flushPendingIdentifiersForModelName(modelName: string, identifiers: StableRecordIdentifier[]) {
    if (this.isDestroying || this.isDestroyed) {
      return;
    }
    let identifiersToRemove: StableRecordIdentifier[] = [];

    for (let j = 0; j < identifiers.length; j++) {
      let i: StableRecordIdentifier = identifiers[j];
      // mark identifiers, so they can once again be processed by the
      // recordArrayManager
      pendingForIdentifier.delete(i);
      // build up a set of models to ensure we have purged correctly;
      let isIncluded = shouldIncludeInRecordArrays(this.store, i);
      if (!isIncluded) {
        identifiersToRemove.push(i);
      }
    }

    let array = this._liveRecordArrays[modelName];
    if (array) {
      // TODO: skip if it only changed
      // process liveRecordArrays
      updateLiveRecordArray(this.store, array, identifiers);
    }

    // process adapterPopulatedRecordArrays
    if (identifiersToRemove.length > 0) {
      removeFromAdapterPopulatedRecordArrays(this.store, identifiersToRemove);
    }
  }

  _flush() {
    let pending = this._pendingIdentifiers;
    this._pendingIdentifiers = Object.create(null) as Dict<StableRecordIdentifier[]>;

    for (let modelName in pending) {
      this._flushPendingIdentifiersForModelName(modelName, pending[modelName]!);
    }
  }

  _syncLiveRecordArray<K extends RecordInstance>(array: RecordArray<K>, modelName: string): void {
    assert(
      `recordArrayManger.syncLiveRecordArray expects modelName not modelClass as the second param`,
      typeof modelName === 'string'
    );
    let pending = this._pendingIdentifiers[modelName];

    if (!Array.isArray(pending)) {
      return;
    }
    let hasNoPotentialDeletions = pending.length === 0;
    let map = internalModelFactoryFor(this.store).modelMapFor(modelName);
    let hasNoInsertionsOrRemovals = map.length === array.length;

    /*
      Ideally the recordArrayManager has knowledge of the changes to be applied to
      liveRecordArrays, and is capable of strategically flushing those changes and applying
      small diffs if desired.  However, until we've refactored recordArrayManager, this dirty
      check prevents us from unnecessarily wiping out live record arrays returned by peekAll.
      */
    if (hasNoPotentialDeletions && hasNoInsertionsOrRemovals) {
      return;
    }

    this._flushPendingIdentifiersForModelName(modelName, pending);
    delete this._pendingIdentifiers[modelName];

    let identifiers = this._visibleIdentifiersByType(modelName);
    let modelsToAdd: StableRecordIdentifier[] = [];
    for (let i = 0; i < identifiers.length; i++) {
      let identifier = identifiers[i];
      let recordArrays = recordArraysForIdentifier(identifier) as unknown as Set<RecordArray<K>>;
      if (recordArrays.has(array) === false) {
        recordArrays.add(array);
        modelsToAdd.push(identifier);
      }
    }

    if (modelsToAdd.length) {
      array._pushIdentifiers(modelsToAdd);
    }
  }

  _didUpdateAll(modelName: string) {
    let recordArray = this._liveRecordArrays[modelName];
    if (recordArray) {
      set(recordArray, 'isUpdating', false);
    }
  }

  /**
    Get the `RecordArray` for a modelName, which contains all loaded records of
    given modelName.

    @method liveRecordArrayFor
    @internal
    @param {String} modelName
    @return {RecordArray}
  */
  liveRecordArrayFor(modelName: string): RecordArray<K> {
    assert(
      `recordArrayManger.liveRecordArrayFor expects modelName not modelClass as the param`,
      typeof modelName === 'string'
    );

    let array = this._liveRecordArrays[modelName];

    if (array) {
      // if the array already exists, synchronize
      this._syncLiveRecordArray(array, modelName);
    } else {
      // if the array is being newly created merely create it with its initial
      // content already set. This prevents unneeded change events.
      let identifiers = this._visibleIdentifiersByType(modelName);
      array = this.createRecordArray(modelName, identifiers);
      this._liveRecordArrays[modelName] = array;
    }

    return array;
  }

  _visibleIdentifiersByType(modelName: string) {
    let all = internalModelFactoryFor(this.store).modelMapFor(modelName).recordIdentifiers;
    let visible: StableRecordIdentifier[] = [];
    for (let i = 0; i < all.length; i++) {
      let identifier = all[i];
      let shouldInclude = shouldIncludeInRecordArrays(this.store, identifier);

      if (shouldInclude) {
        visible.push(identifier);
      }
    }
    return visible;
  }

  /**
    Create a `RecordArray` for a modelName.

    @method createRecordArray
    @internal
    @param {String} modelName
    @param {Array} [identifiers]
    @return {RecordArray}
  */
  createRecordArray(modelName: string, identifiers: StableRecordIdentifier[] = []): RecordArray<K> {
    assert(
      `recordArrayManger.createRecordArray expects modelName not modelClass as the param`,
      typeof modelName === 'string'
    );

    let array: RecordArray<K> = (RecordArray as unknown as RecordArrayCreator).create({
      modelName,
      content: A(identifiers),
      store: this.store,
      isLoaded: true,
      manager: this,
    });

    if (Array.isArray(identifiers)) {
      this._associateWithRecordArray(identifiers, array);
    }

    return array;
  }

  /**
    Create a `AdapterPopulatedRecordArray` for a modelName with given query.

    @method createAdapterPopulatedRecordArray
    @internal
    @param {String} modelName
    @param {Object} query
    @return {AdapterPopulatedRecordArray}
  */
  createAdapterPopulatedRecordArray(
    modelName: string,
    query: Dict<unknown> | undefined,
    identifiers: StableRecordIdentifier[],
    payload?: CollectionResourceDocument
  ): AdapterPopulatedRecordArray<K> {
    assert(
      `recordArrayManger.createAdapterPopulatedRecordArray expects modelName not modelClass as the first param, received ${modelName}`,
      typeof modelName === 'string'
    );

    let array: AdapterPopulatedRecordArray<K>;
    if (Array.isArray(identifiers)) {
      array = (AdapterPopulatedRecordArray as unknown as AdapterPopulatedRecordArrayCreator).create({
        modelName,
        query,
        content: A(identifiers),
        store: this.store,
        manager: this,
        isLoaded: true,
        // TODO this assign kills the root reference but a deep-copy would be required
        // for both meta and links to actually not be by-ref. We whould likely change
        // this to a dev-only deep-freeze.
        meta: assign({} as Meta, payload!.meta),
        links: assign({}, payload!.links),
      });

      this._associateWithRecordArray(identifiers, array);
    } else {
      array = (AdapterPopulatedRecordArray as unknown as AdapterPopulatedRecordArrayCreator).create({
        modelName,
        query,
        content: A(),
        isLoaded: false,
        store: this.store,
        manager: this,
      });
    }

    this._adapterPopulatedRecordArrays.push(array);

    return array;
  }

  /**
    Unregister a RecordArray.
    So manager will not update this array.

    @method unregisterRecordArray
    @internal
    @param {RecordArray} array
  */
  unregisterRecordArray(array: RecordArray<K>): void {
    let modelName = array.modelName;

    // remove from adapter populated record array
    let removedFromAdapterPopulated = removeFromArray(this._adapterPopulatedRecordArrays, array);

    if (!removedFromAdapterPopulated) {
      let liveRecordArrayForType = this._liveRecordArrays[modelName];
      // unregister live record array
      if (liveRecordArrayForType) {
        if (array === liveRecordArrayForType) {
          delete this._liveRecordArrays[modelName];
        }
      }
    }
  }

  /**
   * @method _associateWithRecordArray
   * @internal
   * @param {StableIdentifier} identifiers
   * @param {RecordArray} array
   */
  _associateWithRecordArray(identifiers: StableRecordIdentifier[], array: RecordArray<K>): void {
    for (let i = 0, l = identifiers.length; i < l; i++) {
      let identifier = identifiers[i];
      identifier = getIdentifier(identifier);
      let recordArrays = this.getRecordArraysForIdentifier(identifier);
      recordArrays.add(array);
    }
  }

  /**
    @method recordDidChange
    @internal
  */
  recordDidChange(identifier: StableRecordIdentifier): void {
    if (this.isDestroying || this.isDestroyed) {
      return;
    }
    let modelName = identifier.type;
    identifier = getIdentifier(identifier);

    if (!REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT) {
      const cache = internalModelFactoryFor(this.store);
      const im = peekIMCache(cache, identifier);
      if (im && im._isDematerializing) {
        IMDematerializing.set(identifier, im);
      }
    }

    if (pendingForIdentifier.has(identifier)) {
      return;
    }

    pendingForIdentifier.add(identifier);

    let pending = this._pendingIdentifiers;
    let models = (pending[modelName] = pending[modelName] || []);
    if (models.push(identifier) !== 1) {
      return;
    }

    // TODO do we still need this schedule?
    // eslint-disable-next-line @typescript-eslint/unbound-method
    emberBackburner.schedule('actions', this, this._flush);
  }

  willDestroy() {
    Object.keys(this._liveRecordArrays).forEach((modelName) => this._liveRecordArrays[modelName]!.destroy());
    this._adapterPopulatedRecordArrays.forEach((entry) => entry.destroy());
    this.isDestroyed = true;
  }

  destroy() {
    this.isDestroying = true;
    // TODO do we still need this schedule?
    // eslint-disable-next-line @typescript-eslint/unbound-method
    emberBackburner.schedule('actions', this, this.willDestroy);
  }
}

function removeFromArray<K extends RecordInstance>(array: RecordArray<K>[], item: RecordArray<K>): boolean {
  let index = array.indexOf(item);

  if (index !== -1) {
    array.splice(index, 1);
    return true;
  }

  return false;
}

function updateLiveRecordArray<K extends RecordInstance>(
  store: CoreStore<K>,
  recordArray: RecordArray<K>,
  identifiers: StableRecordIdentifier[]
): void {
  let identifiersToAdd: StableRecordIdentifier[] = [];
  let identifiersToRemove: StableRecordIdentifier[] = [];

  for (let i = 0; i < identifiers.length; i++) {
    let identifier = identifiers[i];
    let shouldInclude = shouldIncludeInRecordArrays(store, identifier);
    let recordArrays = recordArraysForIdentifier(identifier) as unknown as Set<RecordArray<K>>;

    if (shouldInclude) {
      if (!recordArrays.has(recordArray)) {
        identifiersToAdd.push(identifier);
        recordArrays.add(recordArray);
      }
    }

    if (!shouldInclude) {
      identifiersToRemove.push(identifier);
      recordArrays.delete(recordArray);
    }
  }

  if (identifiersToAdd.length > 0) {
    pushIdentifiers(recordArray, identifiersToAdd, internalModelFactoryFor(store));
  }
  if (identifiersToRemove.length > 0) {
    removeIdentifiers(recordArray, identifiersToRemove, internalModelFactoryFor(store));
  }
}

function pushIdentifiers<K extends RecordInstance>(
  recordArray: RecordArray<K>,
  identifiers: StableRecordIdentifier[],
  cache: InternalModelFactory<K>
): void {
  if (!REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT && !recordArray._pushIdentifiers) {
    // TODO deprecate('not allowed to use this intimate api any more');
    (recordArray as unknown as LegacyRecordArray)._pushInternalModels(
      identifiers.map((i) => peekIMCache(cache, i) as InternalModel<K>) // always InternalModel when legacy compat is present
    );
  } else {
    recordArray._pushIdentifiers(identifiers);
  }
}
function removeIdentifiers<K extends RecordInstance>(
  recordArray: RecordArray<K>,
  identifiers: StableRecordIdentifier[],
  cache: InternalModelFactory<K>
): void {
  if (!REMOVE_RECORD_ARRAY_MANAGER_LEGACY_COMPAT && !recordArray._removeIdentifiers) {
    // TODO deprecate('not allowed to use this intimate api any more');
    (recordArray as unknown as LegacyRecordArray)._removeInternalModels(
      identifiers.map((i) => peekIMCache(cache, i) as InternalModel<K>) // always InternalModel when legacy compat is present
    );
  } else {
    recordArray._removeIdentifiers(identifiers);
  }
}

function removeFromAdapterPopulatedRecordArrays<K extends RecordInstance>(store: CoreStore<K>, identifiers: StableRecordIdentifier[]): void {
  for (let i = 0; i < identifiers.length; i++) {
    removeFromAll(store, identifiers[i]);
  }
}

function removeFromAll<K extends RecordInstance>(store: CoreStore<K>, identifier: StableRecordIdentifier): void {
  identifier = getIdentifier(identifier);
  const recordArrays = recordArraysForIdentifier(identifier) as unknown as Set<RecordArray<K>>;
  const cache = internalModelFactoryFor(store);

  recordArrays.forEach(function (recordArray) {
    removeIdentifiers(recordArray, [identifier], cache);
  });

  recordArrays.clear();
}

export default RecordArrayManager;