import type { GroupBase, StylesConfig } from 'react-select'

export type SelectOption = { value: string; label: string }

export const selectStyles: StylesConfig<SelectOption, false, GroupBase<SelectOption>> = {
  control: (base, state) => ({
    ...base,
    minHeight: '2.75rem',
    borderWidth: '1.5px',
    borderColor: state.isFocused ? 'var(--action)' : 'var(--line-strong)',
    borderRadius: 'var(--radius-small)',
    backgroundColor: 'var(--surface)',
    boxShadow: state.isFocused ? '0 0 0 3px var(--action-tint)' : 'none',
    transition: 'border-color var(--fast), box-shadow var(--fast)',
    '&:hover': { borderColor: 'var(--action)' },
  }),
  valueContainer: (base) => ({ ...base, padding: '0.15rem 0.7rem' }),
  input: (base) => ({ ...base, color: 'var(--ink)' }),
  singleValue: (base) => ({ ...base, color: 'var(--ink)' }),
  placeholder: (base) => ({ ...base, color: 'var(--ink-soft)' }),
  menu: (base) => ({ ...base, zIndex: 20, backgroundColor: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)' }),
  menuList: (base) => ({ ...base, maxHeight: '15rem' }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isSelected ? 'var(--action)' : state.isFocused ? 'var(--action-tint)' : 'transparent',
    color: state.isSelected ? 'var(--on-action)' : 'var(--ink)',
    cursor: 'pointer',
  }),
  groupHeading: (base) => ({ ...base, color: 'var(--ink-soft)', fontWeight: 700 }),
  indicatorSeparator: (base) => ({ ...base, backgroundColor: 'var(--line-strong)' }),
  dropdownIndicator: (base) => ({ ...base, color: 'var(--ink-soft)', '&:hover': { color: 'var(--action)' } }),
}
