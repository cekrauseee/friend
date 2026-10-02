import { Shdr14 } from '@/components/ui/shdr-14'
import { useAccentPreference } from '@/hooks/use-accent-preference'

const neutralColors = { ink: '#181b20', paper: '#c2ccd8' }

export function DotOrb({ level }: { level: number }) {
  const { palette } = useAccentPreference()
  return (
    <Shdr14
      className="dot-orb"
      style={{ width: '100%', height: '100%' }}
      colors={palette?.orb ?? neutralColors}
      volumes={{ input: 0, output: 0.3 + level * 0.65 }}
      params={{
        radius: 0.9 + level * 0.02,
        speed: 0.35 + level * 0.95,
        spin: 0.1 + level * 0.2,
        rim: 0,
        gain: 0.95,
      }}
    />
  )
}
