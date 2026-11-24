import { describe, expect, test } from 'bun:test';

import {
  editorReducer,
  initialEditorState,
  jsonEqual,
  type EditorEvent,
  type EditorState,
} from './lock-editor';

interface Config {
  max: number;
}
const reduce = editorReducer<string, Config>(jsonEqual);

function run(...events: EditorEvent<string, Config>[]): EditorState<string, Config> {
  return events.reduce(reduce, initialEditorState<string, Config>());
}

describe('LockAwareEditor state', () => {
  test('editing remembers the server value it started from', () => {
    const state = run(
      { type: 'edit', draft: 'a', server: { max: 1 } },
      { type: 'edit', draft: 'ab', server: { max: 2 } },
    );
    expect(state).toMatchObject({ phase: 'editing', draft: 'ab', base: { max: 1 } });
  });

  test('locked mid-edit: the input stays, read-only, and edits are ignored', () => {
    const state = run(
      { type: 'edit', draft: 'mine', server: { max: 1 } },
      { type: 'lock' },
      { type: 'edit', draft: 'ignored', server: { max: 1 } },
    );
    expect(state).toMatchObject({ phase: 'locked', draft: 'mine', reason: 'lease' });
  });

  test('a save refused with 423 locks the same way, keeping the input', () => {
    const state = run({ type: 'edit', draft: 'mine', server: { max: 1 } }, { type: 'rejected' });
    expect(state).toMatchObject({ phase: 'locked', draft: 'mine', reason: 'rejected' });
  });

  test('released with the server value unchanged: editing goes straight on', () => {
    const state = run(
      { type: 'edit', draft: 'mine', server: { max: 1 } },
      { type: 'lock' },
      { type: 'unlock', server: { max: 1 } },
    );
    expect(state).toMatchObject({ phase: 'editing', draft: 'mine', reason: null });
  });

  test('released with the server value changed: the choice shows', () => {
    const changed = run(
      { type: 'edit', draft: 'mine', server: { max: 1 } },
      { type: 'lock' },
      { type: 'unlock', server: { max: 7 } },
    );
    expect(changed).toMatchObject({ phase: 'server-changed', draft: 'mine', latest: { max: 7 } });

    // "Reload": back to the server value (idle shows it).
    expect(reduce(changed, { type: 'reload' })).toEqual(initialEditorState());

    // "Keep mine": the input stays, now against the new server value.
    expect(reduce(changed, { type: 'keep' })).toMatchObject({
      phase: 'editing',
      draft: 'mine',
      base: { max: 7 },
      latest: null,
    });
  });

  test('a lock while idle changes nothing; saved and cancel go back to idle', () => {
    expect(run({ type: 'lock' })).toEqual(initialEditorState());
    expect(run({ type: 'edit', draft: 'x', server: { max: 1 } }, { type: 'saved' })).toEqual(
      initialEditorState(),
    );
    expect(run({ type: 'edit', draft: 'x', server: { max: 1 } }, { type: 'cancel' })).toEqual(
      initialEditorState(),
    );
  });
});
