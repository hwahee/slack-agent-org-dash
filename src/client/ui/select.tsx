import { useId } from 'react';

interface SelectOption<V extends string> {
  value: V;
  label: string;
}

interface SelectProps<V extends string> {
  label: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** Required: every interactive element must be automatable (docs/ui-automation.md). */
  testId: string;
  disabled?: boolean;
  /** Validation message; wires aria-invalid + aria-describedby like TextField. */
  error?: string;
  /** Visually hides the label (it stays available to assistive tech). */
  hideLabel?: boolean;
}

/** Native <select> — keyboard/screen-reader behavior for free. */
export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled,
  error,
  hideLabel,
}: SelectProps<V>) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label className={hideLabel ? 'visually-hidden' : 'field__label'} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input"
        data-testid={testId}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value as V)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p className="field__error" id={errorId} data-testid={`${testId}.error`}>
          {error}
        </p>
      )}
    </div>
  );
}
