import { Waveform } from '@/components/ui/waveform'

export function MicrophoneWaveform({ bands }: { bands: number[] }) {
  return (
    <div className="microphone-waveform" aria-hidden="true">
      <Waveform
        data={bands}
        height={24}
        barWidth={3}
        barGap={3}
        barHeight={3}
        barRadius={2}
        fadeEdges={false}
      />
    </div>
  )
}
