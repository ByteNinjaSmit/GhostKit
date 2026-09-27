import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface ConfirmButtonProps {
  /** Label of the initial (unarmed) button, e.g. "Delete". */
  label: string
  /** Question shown once armed, e.g. "Delete this session and its transcript?". */
  prompt: string
  /** Label of the button that actually performs the action, e.g. "Yes, delete". */
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  size?: 'default' | 'sm'
}

/**
 * Two-step destructive action: the first click only arms it (showing a
 * question plus explicit confirm/cancel buttons); nothing is deleted until the
 * second, explicit click. Inline rather than `window.confirm` so it is
 * non-blocking, styled with the app, and testable.
 */
function ConfirmButton({ label, prompt, confirmLabel, onConfirm, disabled = false, size = 'sm' }: ConfirmButtonProps): JSX.Element {
  const [armed, setArmed] = useState(false)

  if (!armed) {
    return (
      <Button type="button" variant="outline" size={size} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    )
  }

  return (
    <div role="alert" className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-destructive">{prompt}</span>
      <Button
        type="button"
        variant="destructive"
        size={size}
        disabled={disabled}
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="ghost" size={size} onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </div>
  )
}

export default ConfirmButton
