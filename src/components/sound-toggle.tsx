import { useSyncExternalStore } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { interfaceSounds } from '@/lib/interface-sounds'

export function SoundToggle() {
  const enabled = useSyncExternalStore(interfaceSounds.subscribe, interfaceSounds.getSnapshot, interfaceSounds.getServerSnapshot)
  return (
    <Button type="button" variant="ghost" size="icon-lg" className="sound-toggle"
      aria-label="Interface sounds" aria-pressed={enabled}
      title={enabled ? 'Mute interface sounds' : 'Enable interface sounds'}
      onClick={() => interfaceSounds.setEnabled(!enabled)}>
      {enabled ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
    </Button>
  )
}
