import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import '../styles/select.css'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  icon?: ReactNode
  sizeVariant?: 'regular' | 'compact'
}

/** Native select semantics, shared appearance. Labels, fieldsets, validation and
 * selectOption() continue to target the actual select, not a custom listbox. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { icon, sizeVariant = 'regular', className = '', children, ...props }, ref
) {
  return <span className={`app-select app-select--${sizeVariant}${icon ? ' app-select--icon' : ''}`}>
    <select {...props} ref={ref} className={`app-select__control${className ? ` ${className}` : ''}`}>
      {children}
    </select>
    {icon && <span className="app-select__icon" aria-hidden="true">{icon}</span>}
    <svg className="app-select__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
  </span>
})
