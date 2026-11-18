import type { JSX } from 'react';
import type { Role, TokenScope } from '../../types/api';
import {
  TOKEN_SCOPE_OPTIONS,
  applyTokenScopePreset,
  canUseTeamScopes,
  isTeamScope,
  normalizeTokenScopes,
  toggleTokenScope,
} from '../../lib/tokens';

export interface TokenScopePickerProps {
  role: Role;
  scopes: TokenScope[];
  onChange: (scopes: TokenScope[]) => void;
  disabled?: boolean;
  /** Marks the group as holding an invalid selection. */
  invalid?: boolean;
}

/**
 * Granular scope controls.
 *
 * The default grant is read-only. "Manage my PTO" grants everything a person
 * can do to their own calendar and nothing else — never note reads, never
 * team writes. Note reads require the read scope, so the control is disabled
 * and reset while read is off. Team writes are only offered to a live team
 * lead or administrator.
 */
export function TokenScopePicker({
  role,
  scopes,
  onChange,
  disabled = false,
  invalid = false,
}: TokenScopePickerProps): JSX.Element {
  const teamAllowed = canUseTeamScopes(role);
  const selected = new Set<TokenScope>(scopes);
  const readSelected = selected.has('pto:read');
  const options = TOKEN_SCOPE_OPTIONS.filter((option) => teamAllowed || !isTeamScope(option.scope));

  const handleToggle = (scope: TokenScope): void => {
    onChange(normalizeTokenScopes(toggleTokenScope(scopes, scope, role), role));
  };

  return (
    <fieldset
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className="min-w-0 rounded-lg border border-border bg-surface-2/60 p-4 disabled:opacity-70 dark:border-border-dark dark:bg-surface-dark-2/60"
    >
      <legend className="px-1 font-display text-sm font-semibold tracking-wide text-ink uppercase dark:text-ink-dark">
        Access scopes
      </legend>
      <p className="mb-3 text-sm text-ink-muted dark:text-ink-muted-dark">
        Read-only is the default. Each scope is shown with the exact grant it gives.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange(applyTokenScopePreset('read-only'))}
          className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-3 dark:focus-visible:ring-offset-surface-dark"
        >
          Read only
        </button>
        <button
          type="button"
          onClick={() => onChange(applyTokenScopePreset('manage-my-pto'))}
          className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-3 dark:focus-visible:ring-offset-surface-dark"
        >
          Manage my PTO
        </button>
      </div>

      <ul className="grid gap-2">
        {options.map((option) => {
          const needsRead = option.scope === 'pto:notes:read';
          const optionDisabled = disabled || (needsRead && !readSelected);
          return (
            <li key={option.scope} className="min-w-0">
              <label
                className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded border border-transparent px-2 py-2 text-sm transition-colors duration-150 hover:border-border focus-within:outline-none focus-within:ring-2 focus-within:ring-accent-500 dark:hover:border-border-dark ${
                  optionDisabled ? 'cursor-not-allowed opacity-60' : ''
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
                  checked={selected.has(option.scope)}
                  disabled={optionDisabled}
                  onChange={() => handleToggle(option.scope)}
                />
                <span className="min-w-0">
                  <span className="font-medium break-words text-ink dark:text-ink-dark">
                    {option.label}
                  </span>{' '}
                  <span className="font-mono text-xs break-all text-ink-muted dark:text-ink-muted-dark">
                    {option.scope}
                  </span>
                  <span className="mt-0.5 block text-xs break-words text-ink-muted dark:text-ink-muted-dark">
                    {option.description}
                  </span>
                  {needsRead && !readSelected ? (
                    <span className="mt-0.5 block text-xs break-words text-ink-muted dark:text-ink-muted-dark">
                      Requires the read scope.
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
