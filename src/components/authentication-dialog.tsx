import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Spinner } from '@/components/ui/spinner'
import type { AccessSnapshot } from '@/lib/text-access'

interface AuthenticationDialogProps {
  access: AccessSnapshot
  onSignIn: () => void
  onRetry: () => void
  onCancel: () => void
}

export function AuthenticationDialog({ access, onSignIn, onRetry, onCancel }: AuthenticationDialogProps) {
  const starting = access.checking || (access.authenticated === null && !access.message)
  const connectionError = access.authenticated === null && Boolean(access.message)
  return (
    <AlertDialog open={!starting && access.authenticated !== true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{connectionError ? 'Could not connect' : 'Sign in to Dot'}</AlertDialogTitle>
          <AlertDialogDescription>
            {access.message || 'Sign in with ChatGPT to start your conversation. Your sign-in is managed securely by Codex.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {access.pending ? (
            <AlertDialogCancel onClick={(event) => { event.preventDefault(); onCancel() }}>Cancel sign-in</AlertDialogCancel>
          ) : null}
          <AlertDialogAction
            disabled={access.pending}
            onClick={(event) => {
              event.preventDefault()
              if (connectionError) onRetry()
              else onSignIn()
            }}
          >
            {access.pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
            {access.pending ? 'Signing in…' : connectionError ? 'Retry connection' : 'Sign in with ChatGPT'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
