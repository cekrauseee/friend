import { Spinner } from '@/components/ui/spinner'
import { motion } from 'motion/react'
import { surfaceFade } from '@/lib/surface-motion'

export function GlobalLoading() {
  return (
    <motion.div
      className="global-loading"
      role="status"
      aria-label="Checking sign-in"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={surfaceFade}
    >
      <Spinner aria-hidden="true" />
    </motion.div>
  )
}
