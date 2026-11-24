/**
 * The state of an editor that the control lease can lock mid-edit
 * (docs/testbed/dashboard.md §2.1) — the logic of `LockAwareEditor`, kept
 * free of React so every transition can be tested.
 *
 * - The server value at the moment editing starts is kept as `base`.
 * - When the lease is taken (or a save comes back 423 `LOCKED`), the draft
 *   stays and becomes read-only, with a notice.
 * - When the lease is released: if the server value is still `base`, editing
 *   goes on; if not, the person chooses "reload" (take the server value) or
 *   "keep mine" (keep the draft, now against the new server value).
 */

type EditorPhase = 'idle' | 'editing' | 'locked' | 'server-changed';

export interface EditorState<D, V> {
  phase: EditorPhase;
  /** The person's input; `null` while idle (the server value is shown). */
  draft: D | null;
  /** The server value editing started from (or was last reconciled with). */
  base: V | null;
  /** Why it is locked: the lease was taken, or a save was refused with 423. */
  reason: 'lease' | 'rejected' | null;
  /** The server value seen when the lease was released, if it differs. */
  latest: V | null;
}

export type EditorEvent<D, V> =
  | { type: 'edit'; draft: D; server: V }
  | { type: 'lock' }
  | { type: 'rejected' }
  | { type: 'unlock'; server: V }
  | { type: 'reload' }
  | { type: 'keep' }
  | { type: 'saved' }
  | { type: 'cancel' };

export function initialEditorState<D, V>(): EditorState<D, V> {
  return { phase: 'idle', draft: null, base: null, reason: null, latest: null };
}

export function editorReducer<D, V>(
  equal: (a: V, b: V) => boolean,
): (state: EditorState<D, V>, event: EditorEvent<D, V>) => EditorState<D, V> {
  return (state, event) => {
    switch (event.type) {
      case 'edit':
        if (state.phase === 'locked' || state.phase === 'server-changed') return state;
        return {
          ...state,
          phase: 'editing',
          draft: event.draft,
          base: state.phase === 'idle' ? event.server : state.base,
        };
      case 'lock':
        return state.phase === 'editing' ? { ...state, phase: 'locked', reason: 'lease' } : state;
      case 'rejected':
        return state.phase === 'editing' || state.phase === 'locked'
          ? { ...state, phase: 'locked', reason: 'rejected' }
          : state;
      case 'unlock':
        if (state.phase !== 'locked') return state;
        if (state.base !== null && equal(state.base, event.server)) {
          return { ...state, phase: 'editing', reason: null };
        }
        return { ...state, phase: 'server-changed', reason: null, latest: event.server };
      case 'reload':
        return state.phase === 'server-changed' ? initialEditorState() : state;
      case 'keep':
        return state.phase === 'server-changed'
          ? { ...state, phase: 'editing', base: state.latest, latest: null }
          : state;
      case 'saved':
      case 'cancel':
        return initialEditorState();
    }
  };
}

/** Deep equality for JSON values (config objects, rule lists). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
