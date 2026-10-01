import { LiveWaveform } from '@/components/ui/live-waveform'

export function MicrophoneWaveform({ bands, loading = false }: { bands: number[]; loading?: boolean }) {
  return (
    <div className="microphone-waveform" data-loading={loading} aria-hidden="true">
      <LiveWaveform
        data={bands}
        active={!loading}
        processing={loading}
        sensitivity={1.8}
        height={24}
        barWidth={3}
        barGap={3}
        barHeight={3}
        barRadius={2}
      />
    </div>
  )
}
