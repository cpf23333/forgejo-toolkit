/**
 * A spec-shaped `NodeIterator` for happy-dom's test environment.
 *
 * Why this exists
 * ---------------
 * happy-dom 20.14.5's `NodeIterator` delegates to its `TreeWalker`, and neither
 * implements the DOM Standard's pre-remove steps. Its walk keeps a bare
 * "current node" and steps from it via `firstChild` / `nextSibling` /
 * `parentNode`, so once that node has been removed mid-iteration the walk gives
 * up (or descends into the detached subtree and then gives up) and never reaches
 * the nodes that still follow it in the tree. DOMPurify walks the tree with
 * `document.createNodeIterator(...)` *while removing* forbidden nodes, so on
 * happy-dom it stopped sanitizing after the first removal, leaving `<script>`,
 * inline `style` and `onerror` in `sanitizeMarkdownHtml`'s output.
 *
 * Why first-party rather than `pnpm patch`
 * ----------------------------------------
 * `capricorn86/happy-dom#2310` is still open with no maintainer reply, and the
 * candidate fix (`#2429`) is a self-closed, unreviewed draft that rewrites the
 * whole traversal (+462/−15). happy-dom executes its compiled `lib/**` while
 * that PR only touches `src/**`, so a patch would mean porting an unreviewed
 * draft by hand; and pnpm 11 hard-fails on a `patchedDependencies` entry that
 * stops matching a version bump, including under CI's `--frozen-lockfile`. The
 * traversal itself is small enough to implement from the specification, so this
 * code is first-party (MIT).
 *
 * What is implemented
 * -------------------
 * Everything the DOM Standard's `NodeIterator` has, because DOMPurify also
 * creates one iterator per shadow root and per `template` content: the `root` /
 * `whatToShow` / `filter` getters, `referenceNode`,
 * `pointerBeforeReferenceNode`, `nextNode`, `previousNode`, `detach()` as the
 * specification's no-op, the "is active" re-entrancy guard, and both halves of
 * the removal handling — the `NodeIterator` pre-remove steps, including the
 * `candidate reference` pointer the standard keeps for removals that happen
 * *inside a filter callback*, and the node-pointer adjustment they are built on.
 * The steps are transcribed from
 * https://dom.spec.whatwg.org/#nodeiterator-pre-removing-steps and
 * https://dom.spec.whatwg.org/#concept-nodeiterator-traverse.
 *
 * Two things are happy-dom specific, and both are addressed by discovering the
 * prototype to patch from a *live* object rather than from the global class:
 *
 * - `document.createNodeIterator` is replaced on the prototype that owns it in
 *   the live document's chain, so every document — including the throwaway one
 *   `DOMParser` builds for each sanitize call — returns this iterator. Patching
 *   the global `Document.prototype` would silently do nothing here: in this
 *   environment `document instanceof Document` is false, because the document
 *   object descends from its own `Document` class rather than from the `Document`
 *   binding the test globals expose.
 * - Removals are announced by wrapping happy-dom's single internal removal
 *   choke point: the symbol-keyed `removeChild` on the *base* prototype of the
 *   live node chain, which is the method behind `Node.removeChild`,
 *   `Element.remove`, `Node.replaceChild` and the detach that `insertBefore` /
 *   `appendChild` perform when moving a node that already has a parent. That
 *   puts the hook on the call sites the DOM Standard runs the pre-remove steps
 *   from.
 *
 * Callers must install this before any module that captures
 * `document.createNodeIterator` (DOMPurify captures it at module-init time),
 * which is why it is installed from the vitest `setupFiles` entry.
 */

/** `NodeFilter.FILTER_ACCEPT`, spelled out so this file needs no global. */
const FILTER_ACCEPT = 1;
/** `NodeFilter.FILTER_SKIP`. A `NodeIterator` does not distinguish it from REJECT. */
const FILTER_SKIP = 3;
/** `NodeFilter.SHOW_ALL`, the IDL default for the third `createNodeIterator` argument. */
const SHOW_ALL = 0xffffffff;

/**
 * WebIDL's `NodeFilter` is a callback interface, so a plain function is a legal
 * filter as well as an object with `acceptNode`.
 */
type NodeFilterValue = NodeFilter | ((node: Node) => number) | null;

/** The standard's "node pointer": a node together with which side of it the iterator sits on. */
interface NodePointer {
  node: Node;
  pointerBefore: boolean;
}

type RemovalTarget = Record<PropertyKey, unknown>;

function isNodeLike(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).nodeType === 'number';
}

/** `nodeType` 1..12 map to the `NodeFilter` mask bits in order. */
function whatToShowMask(nodeType: number): number {
  return nodeType >= 1 && nodeType <= 12 ? 1 << (nodeType - 1) : 0;
}

/** Whether `node` is `ancestor` itself or one of its descendants. */
function isInclusiveAncestor(ancestor: Node, node: Node | null): boolean {
  for (let current = node; current !== null; current = current.parentNode) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function lastInclusiveDescendant(node: Node): Node {
  let current = node;
  while (current.lastChild !== null) {
    current = current.lastChild;
  }
  return current;
}

/**
 * The first node following `node` in tree order that is still an inclusive
 * descendant of `root`, or null. `skipChildren` keeps the walk out of `node`'s
 * own subtree, which is how the pre-remove steps exclude the nodes that are
 * about to be removed together with it.
 */
function followingNode(node: Node, root: Node, skipChildren: boolean): Node | null {
  if (!skipChildren && node.firstChild !== null) {
    return node.firstChild;
  }
  for (let current: Node | null = node; current !== null && current !== root; current = current.parentNode) {
    if (current.nextSibling !== null) {
      return current.nextSibling;
    }
  }
  return null;
}

/** The first node preceding `node` in tree order that is an inclusive descendant of `root`, or null. */
function precedingNode(node: Node, root: Node): Node | null {
  if (node === root) {
    return null;
  }
  const previousSibling = node.previousSibling;
  if (previousSibling !== null) {
    return lastInclusiveDescendant(previousSibling);
  }
  return node.parentNode;
}

function createInvalidStateError(): Error {
  const domException = (globalThis as { DOMException?: new (message?: string, name?: string) => Error }).DOMException;
  if (typeof domException === 'function') {
    return new domException('Recursive node filtering', 'InvalidStateError');
  }
  return new Error('Recursive node filtering');
}

/**
 * Every live iterator, grouped by the node document of its root, because the
 * pre-remove steps run for "each NodeIterator object iterator" of the document
 * the removed node belongs to. `WeakRef`s keep a discarded iterator from being
 * pinned by the registry.
 */
const iteratorsByDocument = new WeakMap<Node, Set<WeakRef<SpecNodeIterator>>>();

function nodeDocument(node: Node): Node {
  return node.ownerDocument ?? node;
}

/** https://dom.spec.whatwg.org/#interface-nodeiterator */
class SpecNodeIterator implements NodeIterator {
  readonly root: Node;
  readonly whatToShow: number;

  #filter: NodeFilterValue;
  #reference: NodePointer;
  #candidateReference: NodePointer | null = null;
  #active = false;

  constructor(root: Node, whatToShow: number, filter: NodeFilterValue) {
    if (!isNodeLike(root)) {
      throw new TypeError("Failed to execute 'createNodeIterator': parameter 1 is not of type 'Node'.");
    }
    this.root = root;
    this.whatToShow = whatToShow >>> 0;
    this.#filter = filter;
    this.#reference = { node: root, pointerBefore: true };

    const document = nodeDocument(root);
    let iterators = iteratorsByDocument.get(document);
    if (iterators === undefined) {
      iterators = new Set();
      iteratorsByDocument.set(document, iterators);
    }
    iterators.add(new WeakRef(this));
  }

  get filter(): NodeFilter | null {
    // The value the caller passed is returned unchanged; the DOM typings only
    // describe the `acceptNode` form of WebIDL's callback interface.
    return this.#filter as NodeFilter | null;
  }

  get referenceNode(): Node {
    return this.#reference.node;
  }

  get pointerBeforeReferenceNode(): boolean {
    return this.#reference.pointerBefore;
  }

  nextNode(): Node | null {
    return this.#traverse('next');
  }

  previousNode(): Node | null {
    return this.#traverse('previous');
  }

  detach(): void {
    // The specification defines detach() as doing nothing (it is kept for legacy
    // reasons), so the iterator stays subject to the pre-remove steps.
  }

  /** https://dom.spec.whatwg.org/#concept-nodeiterator-traverse */
  #traverse(type: 'next' | 'previous'): Node | null {
    this.#candidateReference = this.#reference;
    let result: Node | null = null;

    try {
      for (;;) {
        const candidate = this.#candidateReference as NodePointer;
        if (type === 'next') {
          if (!candidate.pointerBefore) {
            const following = followingNode(candidate.node, this.root, false);
            if (following === null) {
              break;
            }
            this.#candidateReference = { node: following, pointerBefore: false };
          } else {
            this.#candidateReference = { node: candidate.node, pointerBefore: false };
          }
        } else {
          if (candidate.pointerBefore) {
            const preceding = precedingNode(candidate.node, this.root);
            if (preceding === null) {
              break;
            }
            this.#candidateReference = { node: preceding, pointerBefore: true };
          } else {
            this.#candidateReference = { node: candidate.node, pointerBefore: true };
          }
        }

        const node = (this.#candidateReference as NodePointer).node;
        if (this.#filterNode(node) === FILTER_ACCEPT) {
          this.#reference = this.#candidateReference;
          result = node;
          break;
        }
      }
    } finally {
      // Both the "no node left" break and a throwing filter leave no candidate.
      this.#candidateReference = null;
    }

    return result;
  }

  /** https://dom.spec.whatwg.org/#concept-node-filter */
  #filterNode(node: Node): number {
    if (this.#active) {
      throw createInvalidStateError();
    }
    if ((whatToShowMask(node.nodeType) & this.whatToShow) === 0) {
      return FILTER_SKIP;
    }
    const filter = this.#filter;
    if (filter === null) {
      return FILTER_ACCEPT;
    }

    this.#active = true;
    try {
      const result = typeof filter === 'function' ? filter(node) : filter.acceptNode(node);
      // WebIDL coerces the callback's return value to an unsigned short.
      return Number(result) & 0xffff;
    } finally {
      this.#active = false;
    }
  }

  /**
   * https://dom.spec.whatwg.org/#nodeiterator-pre-removing-steps
   *
   * Runs before `toRemove` leaves the tree. Both pointers move, so a removal
   * that happens inside a filter callback — while a traversal is in flight —
   * cannot leave the walk pointing into the removed subtree.
   */
  runPreRemovingSteps(toRemove: Node): void {
    this.#reference = this.#adjustNodePointer(this.#reference, toRemove);
    if (this.#candidateReference !== null) {
      this.#candidateReference = this.#adjustNodePointer(this.#candidateReference, toRemove);
    }
  }

  /** https://dom.spec.whatwg.org/#concept-nodeiterator-adjust */
  #adjustNodePointer(pointer: NodePointer, toRemove: Node): NodePointer {
    // The second clause is what keeps the pointer alone when the root itself (or
    // anything above it) is what leaves the tree.
    if (!isInclusiveAncestor(toRemove, pointer.node) || isInclusiveAncestor(toRemove, this.root)) {
      return pointer;
    }

    if (pointer.pointerBefore) {
      const next = followingNode(toRemove, this.root, true);
      if (next !== null) {
        return { node: next, pointerBefore: true };
      }
    }

    // The node just before `toRemove` in tree order: the deepest last descendant
    // of its previous sibling, or its parent when it has none. Both are outside
    // `toRemove`'s subtree by construction.
    const previousSibling = toRemove.previousSibling;
    const node =
      previousSibling === null ? (toRemove.parentNode ?? this.root) : lastInclusiveDescendant(previousSibling);
    return { node, pointerBefore: false };
  }
}

/** Runs the pre-remove steps of every iterator registered on the node's document. */
function runPreRemovingSteps(toRemove: Node): void {
  const iterators = iteratorsByDocument.get(nodeDocument(toRemove));
  if (iterators === undefined) {
    return;
  }
  for (const reference of iterators) {
    const iterator = reference.deref();
    if (iterator === undefined) {
      iterators.delete(reference);
      continue;
    }
    iterator.runPreRemovingSteps(toRemove);
  }
}

/**
 * happy-dom's single internal removal choke point: a `Symbol('removeChild')`
 * keyed method that the public `Node.removeChild`, `ChildNodeUtility.remove`
 * (behind `Element.remove` and `replaceWith`), `Node.replaceChild` and the
 * internal detach performed by `insertBefore` / `appendChild` all route through.
 *
 * It is looked up on the chain of a live node, and the *last* (base) match is
 * used: the subclasses that override it (`Element`, `HTMLTemplateElement`) call
 * the base implementation, so wrapping the base covers every call path, while
 * wrapping the symbol on the global `Node.prototype` could miss the class the
 * live nodes actually descend from.
 */
function findBaseRemovalMethod(node: Node): { prototype: object; key: PropertyKey } | undefined {
  let found: { prototype: object; key: PropertyKey } | undefined;
  for (let prototype = Object.getPrototypeOf(node); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const key = Object.getOwnPropertySymbols(prototype).find((symbol) => symbol.description === 'removeChild');
    if (key !== undefined) {
      found = { prototype, key };
    }
  }
  return found;
}

/** The prototype in `object`'s chain that owns `key`, or undefined when none does. */
function owningPrototype(object: object, key: PropertyKey): object | undefined {
  for (
    let prototype = Object.getPrototypeOf(object);
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (Object.prototype.hasOwnProperty.call(prototype, key)) {
      return prototype;
    }
  }
  return undefined;
}

const REMOVAL_HOOK_MARKER = '__forgejoNodeIteratorRemovalHook';

function wrapRemoval(target: object, key: PropertyKey, removedArgument: 'this' | number): void {
  const original = (target as RemovalTarget)[key];
  if (
    typeof original !== 'function' ||
    (original as unknown as Record<string, unknown>)[REMOVAL_HOOK_MARKER] === true
  ) {
    return;
  }

  const wrapped = function (this: Node, ...args: unknown[]): unknown {
    const removed = removedArgument === 'this' ? this : args[removedArgument];
    if (isNodeLike(removed)) {
      runPreRemovingSteps(removed);
    }
    return (original as (...args: unknown[]) => unknown).apply(this, args);
  };
  Object.defineProperty(wrapped, REMOVAL_HOOK_MARKER, { value: true });

  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    value: wrapped,
    writable: descriptor?.writable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    configurable: descriptor?.configurable ?? true,
  });
}

function installRemovalHook(): void {
  const samples: object[] = [];
  if (document.documentElement !== null) {
    samples.push(document.documentElement);
  }
  samples.push(document.createTextNode(''));

  const chokePoint = findBaseRemovalMethod(samples[0] as Node);
  if (chokePoint !== undefined) {
    wrapRemoval(chokePoint.prototype, chokePoint.key, 0);
    return;
  }

  // Fallback for an environment whose internals are not reachable this way (a
  // renamed symbol, or jsdom when the shim is forced on): cover the public
  // removal entry points instead. Running the pre-remove steps twice for one
  // removal is harmless — the second run finds the pointer already outside the
  // removed subtree and returns it unchanged.
  const methods: [string, 'this' | number][] = [
    ['removeChild', 0],
    ['replaceChild', 1],
    ['remove', 'this'],
  ];
  for (const sample of samples) {
    for (const [key, removedArgument] of methods) {
      const prototype = owningPrototype(sample, key);
      if (prototype !== undefined) {
        wrapRemoval(prototype, key, removedArgument);
      }
    }
  }
}

function createNodeIterator(this: Document, root: Node, whatToShow = SHOW_ALL, filter: NodeFilterValue = null) {
  return new SpecNodeIterator(root, whatToShow, filter);
}

/** Installs the shim into the current global environment. */
export function installNodeIteratorShim(): void {
  installRemovalHook();

  const documentPrototype = owningPrototype(document, 'createNodeIterator');
  if (documentPrototype === undefined) {
    throw new Error('Cannot install the NodeIterator shim: no createNodeIterator in the document chain.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(documentPrototype, 'createNodeIterator');
  Object.defineProperty(documentPrototype, 'createNodeIterator', {
    value: createNodeIterator,
    writable: descriptor?.writable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    configurable: descriptor?.configurable ?? true,
  });
  if (document.createNodeIterator !== createNodeIterator) {
    // A silent miss here would leave DOMPurify walking with a NodeIterator that
    // stops at the first removal, which is the bug this file exists to fix.
    throw new Error('Cannot install the NodeIterator shim: document.createNodeIterator still resolves elsewhere.');
  }

  // Keep `instanceof NodeIterator` and `new NodeIterator(root)` consistent with
  // what createNodeIterator returns. A non-writable global is not worth failing
  // the run over.
  try {
    (window as unknown as Record<string, unknown>).NodeIterator = SpecNodeIterator;
    (globalThis as unknown as Record<string, unknown>).NodeIterator = SpecNodeIterator;
  } catch {
    // Ignore: the traversal itself is installed either way.
  }
}

/**
 * Environment variable that forces the shim on where it is not needed, so the
 * differential check can run this traversal over jsdom's DOM as well.
 */
const FORCE_ENV_VAR = 'FORGEJO_TOOLKIT_FORCE_NODE_ITERATOR_SHIM';

/**
 * happy-dom's window exposes its own detached-window API as `happyDOM`; jsdom's
 * does not. `setupFiles` run after the globals of the environment are installed
 * and before the test module graph, which is exactly where this has to be
 * decided.
 */
export function isHappyDomEnvironment(): boolean {
  return typeof window !== 'undefined' && 'happyDOM' in window;
}

/**
 * Whether to install the shim: always in happy-dom, never in jsdom unless the
 * force variable is set (jsdom's own `NodeIterator` is correct for the paths
 * this suite exercises, and shadowing it would make the differential check
 * compare the shim against itself).
 */
export function shouldInstallNodeIteratorShim(
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {},
): boolean {
  return env[FORCE_ENV_VAR] === '1' || isHappyDomEnvironment();
}

/** Installs the shim when the environment calls for it; reports whether it did. */
export function installNodeIteratorShimIfNeeded(): boolean {
  if (!shouldInstallNodeIteratorShim()) {
    return false;
  }
  installNodeIteratorShim();
  return true;
}
