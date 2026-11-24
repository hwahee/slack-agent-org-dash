/**
 * React side of the lock-aware editor (./lock-editor.ts): follows the lease
 * through `useCanOperate()`, re-reads the server value when the lease is
 * released, and turns a 423 on save into the locked state.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { ApiRequestError } from '../../api/http';
import { useCanOperate } from '../store/hooks';
import { editorReducer, initialEditorState, jsonEqual, type EditorState } from './lock-editor';

export interface LockAwareEditorApi<D, V> {
  state: EditorState<D, V>;
  /** What to show: the draft, or the server value while idle. */
  value: D | null;
  /** True while locked or choosing after a change on the server. */
  readOnly: boolean;
  edit: (draft: D) => void;
  /**
   * Runs `submit` with the draft; a 423 locks the editor and keeps the draft.
   * On success the editor goes back to the server value, unless `keepDraft`
   * (an action form keeps its input for the next run).
   */
  save: <R>(
    submit: (draft: D) => Promise<R>,
    options?: { keepDraft?: boolean },
  ) => Promise<{ ok: true; result: R } | { ok: false; error: unknown }>;
  reload: () => void;
  keep: () => void;
  cancel: () => void;
}

export function useLockAwareEditor<D, V>(options: {
  /** The current server value (`undefined` while loading). */
  server: V | undefined;
  toDraft: (server: V) => D;
  /** Reads the server value again (after the lease is released). */
  refetch: () => Promise<V | undefined>;
  /** `false` for things the lease does not stop (read-only actions). */
  lockable?: boolean;
}): LockAwareEditorApi<D, V> {
  const { server, toDraft, refetch, lockable = true } = options;
  const reducer = useMemo(() => editorReducer<D, V>(jsonEqual), []);
  const [state, dispatch] = useReducer(reducer, undefined, () => initialEditorState<D, V>());
  const canOperate = useCanOperate();
  const locked = lockable && !canOperate;

  // The latest refetch and server value, without making the effect below depend on them.
  const refetchRef = useRef(refetch);
  const serverRef = useRef(server);
  useEffect(() => {
    refetchRef.current = refetch;
    serverRef.current = server;
  }, [refetch, server]);

  const phase = state.phase;
  useEffect(() => {
    if (locked) {
      dispatch({ type: 'lock' });
      return;
    }
    if (phase !== 'locked') return;
    // Released: compare with a fresh server value. If it cannot be read (twice),
    // compare with the last one known rather than stay locked.
    let cancelled = false;
    const read = (): Promise<V | undefined> => refetchRef.current().catch(() => undefined);
    void (async () => {
      let fresh: V | undefined = await read();
      if (fresh === undefined && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        fresh = await read();
      }
      fresh ??= serverRef.current;
      if (!cancelled && fresh !== undefined) dispatch({ type: 'unlock', server: fresh });
    })();
    return () => {
      cancelled = true;
    };
  }, [locked, phase]);

  const edit = useCallback(
    (draft: D) => {
      if (server !== undefined) dispatch({ type: 'edit', draft, server });
    },
    [server],
  );

  const draft = state.draft;
  const save = useCallback(
    async <R>(submit: (value: D) => Promise<R>, saveOptions: { keepDraft?: boolean } = {}) => {
      const value = draft ?? (server === undefined ? null : toDraft(server));
      if (value === null) return { ok: false as const, error: new Error('nothing to save') };
      try {
        const result = await submit(value);
        if (!saveOptions.keepDraft) dispatch({ type: 'saved' });
        return { ok: true as const, result };
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 423) {
          if (draft === null && server !== undefined)
            dispatch({ type: 'edit', draft: value, server });
          dispatch({ type: 'rejected' });
        }
        return { ok: false as const, error };
      }
    },
    [draft, server, toDraft],
  );

  return useMemo(
    () => ({
      state,
      value: state.draft ?? (server === undefined ? null : toDraft(server)),
      readOnly: locked || state.phase === 'locked' || state.phase === 'server-changed',
      edit,
      save,
      reload: () => dispatch({ type: 'reload' }),
      keep: () => dispatch({ type: 'keep' }),
      cancel: () => dispatch({ type: 'cancel' }),
    }),
    [state, server, toDraft, locked, edit, save],
  );
}
