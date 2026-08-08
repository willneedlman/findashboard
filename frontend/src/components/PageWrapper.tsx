import { motion, useReducedMotion } from 'framer-motion'
import PageHeader from './PageHeader'

// Emil's strong ease-out curve — feels more intentional than framer's default easeOut.
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]

const variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.15, ease: EASE_OUT } },
}

interface PageWrapperProps {
  children: React.ReactNode
  title?: string
  meta?: React.ReactNode
}

export default function PageWrapper({ children, title, meta }: PageWrapperProps) {
  // Reduced motion renders the final state directly rather than running the
  // rise at 0.01ms, which reads as a flash.
  const reduced = useReducedMotion()
  return (
    <motion.div className="ft-print-page"
      variants={reduced ? undefined : variants}
      initial={reduced ? false : 'initial'}
      animate={reduced ? false : 'animate'}
      exit={reduced ? undefined : 'exit'}>
      {title && <PageHeader title={title} meta={meta} />}
      {children}
    </motion.div>
  )
}
