import { CircleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { CatalogError, ErrorAction } from '@/lib/types';

/** The button each catalog action shows as. */
export const ACTION_LABELS: Record<ErrorAction, string> = {
  pull: 'Pull image',
  'build-cp': 'Build CP image',
  import: 'Import images',
  start: 'Start Hindsight',
  restart: 'Restart Hindsight',
  settings: 'Open Settings',
  stop: 'Stop Hindsight',
  'trust-cp': 'Review the image',
};

/** A catalog error from the backend: its title, its message (text only) and its one action. */
export function ErrorCard({ error, onAction, busy }: { error: CatalogError; onAction: (a: ErrorAction) => void; busy?: boolean }) {
  return (
    <Alert variant="destructive" data-error-code={error.code}>
      <CircleAlertIcon />
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription>
        <p className="max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap break-words">{error.message}</p>
        <p className="text-xs text-muted-foreground">{error.code}</p>
        {error.action && (
          <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => onAction(error.action!)}>
            {ACTION_LABELS[error.action]}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
